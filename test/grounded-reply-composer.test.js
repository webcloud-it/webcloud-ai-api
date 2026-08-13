import assert from 'node:assert/strict'
import test from 'node:test'

import {
  composeGroundedReply,
  shouldComposeGroundedReply,
} from '../src/core/presentation/groundedReplyComposer.js'

test('composes a natural reply only from verified read data', async () => {
  let prompt = ''
  const result = await composeGroundedReply({
    message: 'analizza lo stato della webcam Barricata',
    result: {
      ok: true,
      intent: 'webcam-detail',
      source: 'tool-fast',
      reply: 'Stream online.',
      data: {type: 'webcam-detail', item: {name: 'Barricata', stream: {status: 'online'}}},
    },
    callLlm: async request => {
      prompt = request.messages[1].content
      return 'Barricata ha lo stream online.'
    },
  })

  assert.equal(result.source, 'llm-grounded')
  assert.equal(result.reply, 'Barricata ha lo stream online.')
  assert.match(prompt, /Barricata/)
  assert.match(prompt, /online/)
})

test('never sends navigation or operational actions to the narrator', async () => {
  const action = {
    ok: true,
    intent: 'app-action',
    source: 'tool-fast',
    reply: 'Apro Barricata.',
    data: {type: 'navigation', path: '/webcamgo/webcams/barricata'},
  }

  assert.equal(shouldComposeGroundedReply({message: 'apri Barricata', result: action}), false)
})

test('falls back to the verified deterministic reply if the model is unavailable', async () => {
  const original = {
    ok: true,
    intent: 'service-detail',
    source: 'tool-fast',
    reply: 'Dettaglio verificato.',
    data: {type: 'service-detail', items: [{servizio: 'example.it'}]},
  }
  const result = await composeGroundedReply({
    message: 'spiegami il servizio',
    result: original,
    callLlm: async () => {
      throw new Error('offline')
    },
  })

  assert.equal(result.reply, original.reply)
  assert.equal(result.source, original.source)
  assert.equal(result.meta.groundedReply, false)
})
