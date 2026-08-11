import test from 'node:test'
import assert from 'node:assert/strict'

import {handleWebcamgoChat} from '../src/modules/facile/webcamgo/chat.js'

function webcam(id, name, slug, location = 'Asiago') {
  return {
    id,
    name,
    slug,
    location,
    reseller: null,
    networkProvider: null,
    inUse: true,
    snapshotEnabled: true,
    hasEncoding: true,
    vpn: false,
    hasMikrotik: false,
    monitoring: {any: true, stream: true},
    status: {
      overall: 'online',
      stream: {status: 'online'},
      snapshot: {status: 'online'},
      connectivity: {status: 'online'},
      mikrotik: {status: null},
    },
    downtime: {configured: false, enabledCount: 0, active: false, activeSchedule: null},
    hardware: {},
  }
}

const webcams = [
  webcam('cam-1', 'Le Melette', 'le-melette', 'Gallio, Melette'),
  webcam('cam-2', 'Asiago Piazza Carli', 'asiago-piazza-carli', 'Asiago'),
  webcam('cam-3', 'Asiago Piazza II Risorgimento', 'asiago-piazza-risorgimento', 'Asiago'),
]

test('apre automaticamente una webcam identificata in modo univoco', () => {
  const result = handleWebcamgoChat({message: 'apri la webcam delle melette', webcams})

  assert.equal(result.intent, 'app-action')
  assert.equal(result.data.type, 'app-action')
  assert.equal(result.data.appAction.path, '/webcamgo/webcams/le-melette')
})

test('tollera un refuso quando il risultato resta univoco', () => {
  const result = handleWebcamgoChat({message: 'aprimi la webcam melete', webcams})

  assert.equal(result.intent, 'app-action')
  assert.equal(result.data.entity.id, 'cam-1')
})

test('propone solo le webcam plausibili quando il nome è ambiguo', () => {
  const result = handleWebcamgoChat({message: 'apri la webcam asiago piazza', webcams})

  assert.equal(result.intent, 'webcam-open-ambiguous')
  assert.equal(result.data.type, 'webcam-list')
  assert.equal(result.data.totale, 2)
  assert.deepEqual(result.data.items.map(item => item.id), ['cam-2', 'cam-3'])
})

test('apre una scelta successiva dalla lista ambigua', () => {
  const first = handleWebcamgoChat({message: 'apri la webcam asiago piazza', webcams})
  const second = handleWebcamgoChat({
    message: 'apri la seconda',
    webcams,
    history: [{role: 'assistant', content: first.reply, data: first.data}],
  })

  assert.equal(second.intent, 'app-action')
  assert.equal(second.data.appAction.path, '/webcamgo/webcams/asiago-piazza-risorgimento')
})

test('non apre una webcam se non esiste una corrispondenza affidabile', () => {
  const result = handleWebcamgoChat({message: 'apri la webcam atlantide', webcams})

  assert.equal(result.intent, 'webcam-open-not-found')
  assert.equal(result.data.type, 'webcam-detail-not-found')
})

test('interpreta gli stati di una webcam come dettaglio e ripulisce il nome entità', () => {
  const result = handleWebcamgoChat({
    message: 'stati della webcam Asiago Piazza Carli',
    webcams,
  })

  assert.equal(result.intent, 'webcam-detail')
  assert.equal(result.data.item.id, 'cam-2')
  assert.match(result.reply, /Stream: online/)
  assert.match(result.reply, /Snapshot: online/)
})

test('usa la webcam della pagina per richieste implicite e follow-up tecnici', () => {
  const context = {activeEntity: {type: 'webcam', slug: 'asiago-piazza-carli'}}

  for (const message of ['mostrami gli stati', 'e lo snapshot?', 'il router funziona?']) {
    const result = handleWebcamgoChat({message, context, webcams})
    assert.equal(result.intent, 'webcam-detail', message)
    assert.equal(result.data.item.id, 'cam-2', message)
  }
})

test('apre la webcam corrente con un pronome', () => {
  const result = handleWebcamgoChat({
    message: 'aprila',
    context: {activeEntity: {type: 'webcam', slug: 'le-melette'}},
    webcams,
  })

  assert.equal(result.intent, 'app-action')
  assert.equal(result.data.appAction.path, '/webcamgo/webcams/le-melette')
})
