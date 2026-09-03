import test from 'node:test'
import assert from 'node:assert/strict'

import {callOllamaChat, checkOllamaReadiness} from '../src/core/providers/ollamaProvider.js'
import {env} from '../src/config/env.js'

test('chat usa il modello operativo senza thinking e lo mantiene caricato', async () => {
  let requestBody = null

  const content = await callOllamaChat({
    messages: [{role: 'user', content: 'ciao'}],
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body)

      return {
        ok: true,
        json: async () => ({message: {content: 'risposta'}}),
      }
    },
  })

  assert.equal(content, 'risposta')
  assert.equal(requestBody.model, env.ollamaChatModel)
  assert.equal(requestBody.think, false)
  assert.equal(requestBody.keep_alive, '10m')
})

test('readiness conferma la presenza del modello configurato', async () => {
  const result = await checkOllamaReadiness({
    model: 'qwen3:8b',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({models: [{name: 'qwen3:8b'}]}),
    }),
  })

  assert.deepEqual(result, {ok: true, model: 'qwen3:8b', reason: null})
})

test('readiness distingue un servizio attivo da un modello non installato', async () => {
  const result = await checkOllamaReadiness({
    model: 'qwen3:8b',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({models: [{name: 'qwen3:4b'}]}),
    }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'model-not-installed')
})

test('readiness non espone dettagli di rete quando Ollama non è raggiungibile', async () => {
  const result = await checkOllamaReadiness({
    model: 'qwen3:8b',
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.7:11434')
    },
  })

  assert.deepEqual(result, {ok: false, model: 'qwen3:8b', reason: 'unreachable'})
})
