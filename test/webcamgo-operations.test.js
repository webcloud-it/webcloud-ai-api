import test from 'node:test'
import assert from 'node:assert/strict'

import {handleWebcamgoOperation} from '../src/modules/facile/webcamgo/operations.js'

const webcams = [
  {id: 'cam-1', name: 'Piazza Centrale', slug: 'piazza-centrale', location: 'Asiago'},
  {id: 'cam-2', name: 'Piazza Sud', slug: 'piazza-sud', location: 'Asiago'},
]

test('webcam reboot creates a secret-free confirmation proposal', async () => {
  const result = await handleWebcamgoOperation({message: 'Riavvia la webcam piazza-centrale', webcams})

  assert.equal(result.intent, 'webcam-reboot-preview')
  assert.equal(result.data.type, 'action-proposal')
  assert.equal(result.data.target.id, 'cam-1')
  assert.ok(result.data.proposalToken)
  assert.equal(JSON.stringify(result).includes('password'), false)
})

test('webcam reboot executes only after confirmation with the opaque token', async () => {
  const preview = await handleWebcamgoOperation({message: 'Reboot "piazza-centrale"', webcams, token: 'directus-token'})
  let executed = null
  const result = await handleWebcamgoOperation({
    message: 'confermo',
    webcams,
    token: 'directus-token',
    history: [{role: 'assistant', content: preview.reply, data: preview.data}],
    executeReboot: async options => {
      executed = options
      return {ok: true, via: 'onvif'}
    },
  })

  assert.deepEqual(executed, {token: 'directus-token', webcamId: 'cam-1'})
  assert.equal(result.intent, 'webcam-reboot-executed')
  assert.equal(result.data.result.via, 'onvif')
})

test('webcam proposals cannot be confirmed from another session', async () => {
  const preview = await handleWebcamgoOperation({message: 'Reboot "piazza-centrale"', webcams, token: 'owner-token'})
  let executed = false
  const result = await handleWebcamgoOperation({
    message: 'confermo',
    webcams,
    token: 'other-token',
    history: [{role: 'assistant', content: preview.reply, data: preview.data}],
    executeReboot: async () => {
      executed = true
    },
  })

  assert.equal(result.intent, 'action-error')
  assert.equal(result.data.error.code, 'action-owner-mismatch')
  assert.equal(executed, false)
})

test('ambiguous webcam reboot asks for an exact target', async () => {
  const result = await handleWebcamgoOperation({message: 'Riavvia webcam Piazza', webcams})

  assert.equal(result.intent, 'clarification')
  assert.equal(result.data.reason, 'webcam-ambiguous')
})

test('webcam operations resolve pronouns from the active page entity', async () => {
  const result = await handleWebcamgoOperation({
    message: 'Riavvia questa webcam',
    context: {activeEntity: {type: 'webcam', slug: 'piazza-centrale'}},
    webcams,
  })

  assert.equal(result.intent, 'webcam-reboot-preview')
  assert.equal(result.data.target.id, 'cam-1')
})

test('webcam device diagnostics return only sanitized information', async () => {
  let inspected = null
  const result = await handleWebcamgoOperation({
    message: 'Mostrami firmware e info dispositivo della webcam "piazza-centrale"',
    webcams,
    token: 'directus-token',
    executeInspect: async options => {
      inspected = options
      return {
        ok: true,
        webcam: {id: 'cam-1', name: 'Piazza Centrale'},
        modelNumber: 'IPC-42',
        firmwareVersion: '1.2.3',
        serialNumber: 'SERIAL-1',
        onvifVersion: '2.6',
      }
    },
  })

  assert.deepEqual(inspected, {token: 'directus-token', webcamId: 'cam-1'})
  assert.equal(result.intent, 'webcam-device-info')
  assert.match(result.reply, /IPC-42/)
  assert.equal(JSON.stringify(result).includes('directus-token'), false)
})

test('live connectivity check resolves the webcam without exposing its address', async () => {
  const result = await handleWebcamgoOperation({
    message: 'Verifica la connettività della webcam piazza-centrale',
    webcams,
    token: 'directus-token',
    executeConnectivity: async () => ({
      ok: true,
      webcam: {id: 'cam-1', name: 'Piazza Centrale'},
      reachable: true,
      port: 443,
    }),
  })

  assert.equal(result.intent, 'webcam-connectivity-live')
  assert.match(result.reply, /raggiungibile/)
  assert.equal(JSON.stringify(result).includes('192.168.'), false)
})

test('snapshot response exposes only a safe public action', async () => {
  const result = await handleWebcamgoOperation({
    message: 'Mostra lo snapshot della webcam piazza-centrale',
    webcams,
  })

  assert.equal(result.intent, 'webcam-snapshot')
  assert.equal(result.data.actions[0].id, 'open-url')
  assert.match(result.data.actions[0].url, /^https:\/\/snapshot\.webcamgo\.com\//)
  assert.equal(result.data.actions[0].url.includes('pass='), false)
})

test('natural snapshot wording keeps only the webcam name as target', async () => {
  const result = await handleWebcamgoOperation({
    message: 'Mostrami lo snapshot della webcam Piazza Centrale.',
    webcams,
  })

  assert.equal(result.intent, 'webcam-snapshot')
  assert.equal(result.data.target.id, 'cam-1')
})

test('preset listing resolves a webcam and returns sanitized preset metadata', async () => {
  const result = await handleWebcamgoOperation({
    message: 'Mostra i preset della webcam piazza-centrale',
    webcams,
    token: 'directus-token',
    executePresets: async () => ({
      ok: true,
      webcam: {id: 'cam-1', name: 'Piazza Centrale'},
      presets: [{token: '1', name: 'Home'}, {token: '2', name: 'Montagna'}],
    }),
  })

  assert.equal(result.intent, 'webcam-presets')
  assert.match(result.reply, /Home/)
  assert.match(result.reply, /Montagna/)
  assert.equal(JSON.stringify(result).includes('directus-token'), false)
})

test('preset PTZ and live connectivity qualifiers do not contaminate the target', async () => {
  const presets = await handleWebcamgoOperation({
    message: 'Quali preset PTZ sono disponibili per Piazza Centrale?',
    webcams,
    executePresets: async () => ({presets: []}),
  })
  const connectivity = await handleWebcamgoOperation({
    message: 'Controlla la connettività live di Piazza Centrale.',
    webcams,
    executeConnectivity: async () => ({reachable: true, port: 443}),
  })

  assert.equal(presets.intent, 'webcam-presets')
  assert.equal(connectivity.intent, 'webcam-connectivity-live')
})

test('diagnostica tecnica mantiene il nome della webcam come target', async () => {
  const result = await handleWebcamgoOperation({
    message: 'Fammi una diagnostica tecnica della webcam Piazza Centrale.',
    webcams,
    executeInspect: async () => ({
      modelNumber: 'IPC-42',
      firmwareVersion: '1.2.3',
      serialNumber: 'SERIAL-1',
      onvifVersion: '2.6',
    }),
  })

  assert.equal(result.intent, 'webcam-device-info')
  assert.match(result.reply, /Piazza Centrale/)
})

test('preset listing explains when the webcam does not support PTZ', async () => {
  const result = await handleWebcamgoOperation({
    message: 'Mostra i preset della webcam piazza-centrale',
    webcams,
    token: 'directus-token',
    executePresets: async () => {
      throw new Error('Errore lettura preset webcam (500) {"message":"ONVIF SOAP Fault: PTZ is not supported"}')
    },
  })

  assert.equal(result.intent, 'webcam-presets-unsupported')
  assert.match(result.reply, /non supporta i controlli PTZ/)
  assert.equal(result.reply.includes('SOAP'), false)
})

test('moving to a webcam preset requires confirmation and keeps the token server-side', async () => {
  const preview = await handleWebcamgoOperation({
    message: 'Porta la webcam piazza-centrale al preset Home',
    webcams,
    token: 'directus-token',
    executePresets: async () => ({presets: [{token: 'secret-device-token', name: 'Home'}]}),
  })

  assert.equal(preview.intent, 'webcam-goto-preset-preview')
  assert.equal(preview.data.operation, 'webcam-goto-preset')
  assert.equal(JSON.stringify(preview).includes('secret-device-token'), false)

  let executed = null
  const result = await handleWebcamgoOperation({
    message: 'confermo',
    webcams,
    token: 'directus-token',
    history: [{role: 'assistant', content: preview.reply, data: preview.data}],
    executeGotoPreset: async options => {
      executed = options
      return {ok: true, via: 'onvif'}
    },
  })

  assert.deepEqual(executed, {token: 'directus-token', webcamId: 'cam-1', presetToken: 'secret-device-token'})
  assert.equal(result.intent, 'webcam-goto-preset-executed')
})

test('preset movement can be cancelled without calling the control API', async () => {
  const preview = await handleWebcamgoOperation({
    message: 'Vai al preset Montagna sulla webcam piazza-centrale',
    webcams,
    executePresets: async () => ({presets: [{token: '2', name: 'Montagna'}]}),
  })
  let executed = false
  const result = await handleWebcamgoOperation({
    message: 'annulla',
    history: [{role: 'assistant', content: preview.reply, data: preview.data}],
    executeGotoPreset: async () => {
      executed = true
    },
  })

  assert.equal(result.intent, 'cancelled')
  assert.equal(result.data.operation, 'webcam-goto-preset')
  assert.equal(executed, false)
})
