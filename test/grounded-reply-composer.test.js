import assert from 'node:assert/strict'
import test from 'node:test'

import {
  composeGroundedReply,
  shouldComposeGroundedReply,
  validateGroundedReply,
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
      data: {
        type: 'webcam-detail',
        item: {
          name: 'Barricata',
          status: {stream: {status: 'online'}},
          rawInternalPayload: 'dato non necessario',
        },
      },
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
  assert.doesNotMatch(prompt, /rawInternalPayload|dato non necessario/)
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

test('respects an explicit deterministic narration policy', () => {
  const result = {
    ok: true,
    intent: 'webcam-anomaly-analysis',
    source: 'tool-fast',
    reply: 'Sintesi verificata.',
    data: {type: 'webcam-anomaly-analysis'},
    meta: {narrationPolicy: 'deterministic'},
  }

  assert.equal(shouldComposeGroundedReply({message: 'analizza le anomalie', result}), false)
})

test('keeps a verified webcam assessment deterministic when requested by the route', () => {
  const result = {
    ok: true,
    intent: 'webcam-detail',
    source: 'tool-fast',
    reply: 'Barricata non presenta anomalie correnti.',
    data: {type: 'webcam-detail', item: {name: 'Barricata'}},
    meta: {narrationPolicy: 'deterministic'},
  }

  assert.equal(shouldComposeGroundedReply({message: 'analizza Barricata', result}), false)
})

test('caps narration latency even when the environment allows a longer timeout', async () => {
  let timeoutMs = null
  await composeGroundedReply({
    message: 'analizza lo stato della webcam Barricata',
    result: {
      ok: true,
      intent: 'webcam-detail',
      source: 'tool-fast',
      reply: 'Barricata è online.',
      data: {type: 'webcam-detail', item: {name: 'Barricata'}},
    },
    callLlm: async request => {
      timeoutMs = request.timeoutMs
      return 'Barricata è online.'
    },
  })

  assert.ok(timeoutMs <= 5000)
})

test('keeps simple read lists deterministic to avoid unnecessary latency', () => {
  const result = {
    ok: true,
    intent: 'read-query',
    source: 'tool-fast',
    reply: 'Ho trovato 2 clienti.',
    data: {type: 'read-query-result', items: [{name: 'A'}, {name: 'B'}]},
  }

  assert.equal(
    shouldComposeGroundedReply({
      message: 'quali clienti scadono a settembre 2026',
      result,
    }),
    false
  )
})

test('keeps a simple verified ranking comparison deterministic', () => {
  const result = {
    ok: true,
    intent: 'read-query',
    source: 'tool-fast',
    reply: 'Primo MisterDomain con 74, secondo Aruba con 50, distacco 24.',
    data: {type: 'read-query-result', operation: 'aggregate', items: []},
  }

  assert.equal(
    shouldComposeGroundedReply({message: 'Confronta i primi due.', result}),
    false
  )
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

test('rejects a fluent reply when the model introduces an unsupported number', async () => {
  const original = {
    ok: true,
    intent: 'webcam-anomaly-analysis',
    source: 'tool-fast',
    reply: 'Ho trovato 2 webcam con 5 episodi.',
    data: {
      type: 'webcam-anomaly-analysis',
      summary: {webcamsWithMatchingAnomalies: 2, totalIncidents: 5},
      items: [],
    },
  }
  const result = await composeGroundedReply({
    message: 'analizza le anomalie ricorrenti',
    result: original,
    callLlm: async () => 'Ho trovato 2 webcam con 37 episodi.',
  })

  assert.equal(result.source, 'tool-fast')
  assert.equal(result.reply, original.reply)
  assert.equal(result.meta.groundedReplyRejected, 'unsupported-numeric-fact')
})

test('accepts Italian decimal formatting when the verified value is equivalent', () => {
  assert.deepEqual(
    validateGroundedReply({
      reply: 'Il distacco verificato è 2,5%.',
      fallback: 'Distacco disponibile.',
      groundedData: '{"gapPercentage":2.5}',
    }),
    {ok: true, reason: null}
  )
})

test('validates numbers written in words and rejects unsupported causal conclusions', () => {
  assert.equal(
    validateGroundedReply({
      reply: 'Le webcam coinvolte sono tre.',
      fallback: 'Ho trovato 2 webcam.',
      groundedData: '{}',
    }).reason,
    'unsupported-numeric-fact'
  )
  assert.equal(
    validateGroundedReply({
      reply: 'Il problema è causato dal provider EOLO.',
      fallback: 'EOLO è una caratteristica condivisa.',
      groundedData: '{"type":"webcam-anomaly-analysis"}',
    }).reason,
    'unsupported-causal-claim'
  )
})
