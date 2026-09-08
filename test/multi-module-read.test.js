import test from 'node:test'
import assert from 'node:assert/strict'

import {
  executeMultiModuleRead,
  validateMultiModuleReadPlan,
} from '../src/core/orchestrator/multiModuleRead.js'

const plan = {
  type: 'multi-module',
  tasks: [
    {moduleId: 'facile.webcamgo', canonicalMessage: 'quante webcam sono offline', operation: 'read'},
    {moduleId: 'facile.sendinitaly', canonicalMessage: 'quanti ticket sono da gestire', operation: 'read'},
  ],
}

const req = {
  body: {message: 'Confronta il numero di webcam offline con i ticket da gestire.'},
  auth: {credentials: {webcamgo: 'webcam-token', specialk: 'specialk-token'}},
}

test('validates independent read-only tasks for different modules', () => {
  assert.equal(validateMultiModuleReadPlan(plan, req.body.message).ok, true)
})

test('rejects mixed read/write plans before invoking any module', () => {
  const unsafe = {
    ...plan,
    tasks: [
      plan.tasks[0],
      {moduleId: 'facile.sendinitaly', canonicalMessage: 'invia una risposta al ticket 25004', operation: 'write'},
    ],
  }

  assert.equal(validateMultiModuleReadPlan(unsafe, 'Controlla le webcam e invia la risposta').ok, false)
})

test('executes all module reads and composes only grounded evidence', async () => {
  const replies = {
    'facile.webcamgo': {ok: true, intent: 'webcam-list', reply: 'Risultano 3 webcam offline.', data: {type: 'webcam-list', total: 3}},
    'facile.sendinitaly': {ok: true, intent: 'sendinitaly-support-analysis', reply: 'Risultano 2 ticket da gestire.', data: {type: 'sendinitaly-support-analysis', total: 2}},
  }
  const result = await executeMultiModuleRead({
    plan,
    req,
    invokeTask: async ({task}) => replies[task.moduleId],
    callLlm: async () => 'La situazione richiede attenzione: ci sono 3 webcam offline e 2 ticket da gestire.',
  })

  assert.equal(result.ok, true)
  assert.equal(result.source, 'llm-grounded')
  assert.equal(result.data.results.length, 2)
  assert.match(result.reply, /3 webcam offline/i)
  assert.match(result.reply, /2 ticket/i)
})

test('keeps simple multi-area reads on a fast deterministic response', async () => {
  let modelCalled = false
  const result = await executeMultiModuleRead({
    plan,
    req: {...req, body: {message: 'Quante webcam sono offline e quanti ticket sono da gestire?'}},
    invokeTask: async ({task}) => task.moduleId === 'facile.webcamgo'
      ? {ok: true, intent: 'webcam-list', reply: 'Risultano 3 webcam offline.', data: {type: 'webcam-list', total: 3}}
      : {ok: true, intent: 'sendinitaly-support-analysis', reply: 'Risultano 2 ticket da gestire.', data: {type: 'sendinitaly-support-analysis', total: 2}},
    callLlm: async () => {
      modelCalled = true
      return 'non deve essere chiamato'
    },
  })

  assert.equal(modelCalled, false)
  assert.equal(result.source, 'tool-multi')
  assert.match(result.reply, /WebcamGo:/)
  assert.match(result.reply, /Assistenza e Send in Italy:/)
})

test('rejects an LLM number absent from the verified module results', async () => {
  const result = await executeMultiModuleRead({
    plan,
    req,
    invokeTask: async ({task}) => task.moduleId === 'facile.webcamgo'
      ? {ok: true, intent: 'webcam-list', reply: 'Risultano 3 webcam offline.', data: {type: 'webcam-list', total: 3}}
      : {ok: true, intent: 'sendinitaly-support-analysis', reply: 'Risultano 2 ticket da gestire.', data: {type: 'sendinitaly-support-analysis', total: 2}},
    callLlm: async () => 'In totale ci sono 99 elementi problematici.',
  })

  assert.equal(result.source, 'tool-multi')
  assert.match(result.reply, /3 webcam offline/i)
  assert.match(result.reply, /2 ticket/i)
  assert.doesNotMatch(result.reply, /99/)
})

test('returns verified partial results when one read source is unavailable', async () => {
  const result = await executeMultiModuleRead({
    plan,
    req,
    invokeTask: async ({task}) => {
      if (task.moduleId === 'facile.sendinitaly') {
        throw Object.assign(new Error('unavailable'), {code: 'module-unavailable'})
      }
      return {ok: true, intent: 'webcam-list', reply: 'Risultano 3 webcam offline.', data: {type: 'webcam-list', total: 3}}
    },
    callLlm: async () => 'Risultano 3 webcam offline; i ticket non sono determinabili.',
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.results.length, 1)
  assert.deepEqual(result.data.failures, [{moduleId: 'facile.sendinitaly', code: 'module-unavailable'}])
})
