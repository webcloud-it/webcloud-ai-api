import test from 'node:test'
import assert from 'node:assert/strict'

import {handleWebcamgoChat} from '../src/modules/facile/webcamgo/chat.js'
import {parseWebcamHistoryRequest} from '../src/modules/facile/webcamgo/queries.js'

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

test('il riepilogo non considera gli stati N/A come problemi reali', () => {
  const withUnknownConnectivity = webcam('cam-na', 'Webcam senza test', 'webcam-na')
  withUnknownConnectivity.status.connectivity.status = 'na'
  withUnknownConnectivity.hasMikrotik = true
  withUnknownConnectivity.status.mikrotik.status = 'unknown'

  const result = handleWebcamgoChat({
    message: 'Dammi un riepilogo generale di WebcamGo.',
    webcams: [withUnknownConnectivity],
  })

  assert.match(result.reply, /problemi di connettività: 0/i)
  assert.match(result.reply, /MikroTik non online: 0/i)
})

test('riconosce il downtime programmato attivo senza confonderlo con quello configurato', () => {
  const active = webcam('cam-active', 'Webcam in downtime', 'cam-active')
  active.downtime = {configured: true, enabledCount: 1, active: true, activeSchedule: {}}
  const configured = webcam('cam-configured', 'Webcam pianificata', 'cam-configured')
  configured.downtime = {configured: true, enabledCount: 1, active: false, activeSchedule: null}

  const result = handleWebcamgoChat({
    message: 'Quali webcam hanno un downtime programmato attivo?',
    webcams: [active, configured],
  })

  assert.equal(result.data.totale, 1)
  assert.equal(result.data.items[0].id, 'cam-active')
})

test('una lista filtrata resta plurale anche nella pagina di una webcam', () => {
  const result = handleWebcamgoChat({
    message: 'Mostrami le webcam monitorate con snapshot abilitato.',
    context: {activeEntity: {type: 'webcam', slug: 'le-melette'}},
    webcams,
  })

  assert.equal(result.intent, 'webcam-list')
  assert.equal(result.data.totale, 3)
})

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

test('separa il nome webcam dalle clausole narrative successive', () => {
  const result = handleWebcamgoChat({
    message: 'Analizza lo stato della webcam Le Melette e dimmi se c’è qualcosa da controllare.',
    webcams,
  })

  assert.equal(result.intent, 'webcam-detail')
  assert.equal(result.data.item.id, 'cam-1')
  assert.match(result.reply, /Le Melette/i)
  assert.match(result.reply, /Valutazione operativa/i)
  assert.doesNotMatch(result.reply, /Non ho trovato/i)
})

test('usa la webcam della pagina per richieste implicite e follow-up tecnici', () => {
  const context = {activeEntity: {type: 'webcam', slug: 'asiago-piazza-carli'}}

  for (const message of ['mostrami gli stati', 'e lo snapshot?', 'il router funziona?']) {
    const result = handleWebcamgoChat({message, context, webcams})
    assert.equal(result.intent, 'webcam-detail', message)
    assert.equal(result.data.item.id, 'cam-2', message)
  }
})

test('usa la webcam aperta invece di interpretare i campi richiesti come nome', () => {
  const result = handleWebcamgoChat({
    message: 'Qual è lo stato di stream, snapshot e router della webcam aperta?',
    context: {activeEntity: {type: 'webcam', slug: 'le-melette'}},
    webcams,
  })

  assert.equal(result.intent, 'webcam-detail')
  assert.equal(result.data.item.id, 'cam-1')
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

test('non perde la richiesta quando è preceduta da un saluto', () => {
  const result = handleWebcamgoChat({
    message: 'Ciao, dimmi come sta questa webcam e se funzionano stream, snapshot e router',
    context: {activeEntity: {type: 'webcam', slug: 'le-melette'}},
    webcams,
  })

  assert.equal(result.intent, 'webcam-detail')
  assert.equal(result.data.item.id, 'cam-1')
})

test('combina località e stati alternativi senza includere parole della frase nel luogo', () => {
  const gallioOffline = webcam('cam-4', 'Gallio Centro', 'gallio-centro', 'Gallio')
  gallioOffline.status.overall = 'offline'
  gallioOffline.status.stream.status = 'offline'
  const gallioSnapshot = webcam('cam-5', 'Gallio Panorama', 'gallio-panorama', 'Gallio')
  gallioSnapshot.status.overall = 'offline'
  gallioSnapshot.status.snapshot.status = 'offline'
  const asiagoOffline = webcam('cam-6', 'Asiago Offline', 'asiago-offline', 'Asiago')
  asiagoOffline.status.overall = 'offline'

  const result = handleWebcamgoChat({
    message: 'Quali webcam a Gallio sono offline o hanno lo snapshot bloccato?',
    webcams: [...webcams, gallioOffline, gallioSnapshot, asiagoOffline],
  })

  assert.equal(result.intent, 'webcam-list')
  assert.equal(result.data.query.term, 'Gallio')
  assert.equal(result.data.query.filterMode, 'any')
  assert.deepEqual(result.data.query.filters, ['snapshot-offline', 'offline'])
  assert.deepEqual(result.data.items.map(item => item.id).sort(), ['cam-4', 'cam-5'])
})

test('applica la località anche quando segue lo stato richiesto', () => {
  const gallioOffline = webcam('cam-4', 'Gallio Centro', 'gallio-centro', 'Gallio')
  gallioOffline.status.overall = 'offline'
  gallioOffline.status.stream.status = 'offline'
  const asiagoOffline = webcam('cam-5', 'Asiago Centro', 'asiago-centro', 'Asiago')
  asiagoOffline.status.overall = 'offline'
  asiagoOffline.status.stream.status = 'offline'

  const result = handleWebcamgoChat({
    message: 'Mostrami le webcam offline a Gallio',
    webcams: [...webcams, gallioOffline, asiagoOffline],
  })

  assert.equal(result.intent, 'webcam-list')
  assert.equal(result.data.query.term, 'Gallio')
  assert.deepEqual(result.data.query.filters, ['offline'])
  assert.deepEqual(result.data.items.map(item => item.id), ['cam-4'])
})

test('comprende le negazioni con il verbo essere nei filtri di configurazione', () => {
  const disabled = webcam('cam-4', 'Disattivata', 'disattivata', 'Gallio')
  disabled.inUse = false
  disabled.monitoring.any = false
  disabled.status.overall = 'offline'
  const active = webcam('cam-5', 'Attiva', 'attiva', 'Gallio')
  active.status.overall = 'offline'

  const notInUse = handleWebcamgoChat({
    message: 'Quali webcam sono offline e non sono in uso?',
    webcams: [disabled, active],
  })
  const unmonitored = handleWebcamgoChat({
    message: 'Quante webcam non sono monitorate?',
    webcams: [disabled, active],
  })

  assert.deepEqual(notInUse.data.query.filters, ['not-in-use', 'offline'])
  assert.deepEqual(notInUse.data.items.map(item => item.id), ['cam-4'])
  assert.deepEqual(unmonitored.data.query.filters, ['unmonitored'])
  assert.deepEqual(unmonitored.data.items.map(item => item.id), ['cam-4'])
})

test('tratta prime cinque webcam come nuova lista limitata e non come paginazione', () => {
  const result = handleWebcamgoChat({
    message: 'Mostrami le prime cinque webcam con lo snapshot non online.',
    webcams,
  })

  assert.equal(result.intent, 'webcam-list')
  assert.equal(result.data.query.limit, 5)
  assert.deepEqual(result.data.query.filters, ['snapshot-offline'])
})

test('interpreta ferme come anomalie correnti e mostra da quando sono iniziate', () => {
  const offline = webcam('cam-4', 'Gallio Centro', 'gallio-centro', 'Gallio')
  offline.status.overall = 'offline'
  offline.status.stream = {
    status: 'offline',
    changedOn: '2026-08-20T08:00:00.000Z',
  }

  const result = handleWebcamgoChat({
    message: 'Quali webcam abbiamo ferme in questo momento e da quando?',
    webcams: [...webcams, offline],
  })

  assert.equal(result.intent, 'webcam-list')
  assert.deepEqual(result.data.query.filters, ['stopped'])
  assert.equal(result.data.query.includeStatusSince, true)
  assert.deepEqual(result.data.items.map(item => item.id), ['cam-4'])
  assert.match(result.reply, /stream offline dal/i)
  assert.match(result.reply, /20\/08\/26/)
})

test('filtra lo storico per interruzioni superiori alla durata richiesta', () => {
  const now = new Date('2026-08-12T12:00:00.000Z')
  const statusLogs = [
    {webcamId: 'cam-1', type: 'stream', status: 'offline', changedOn: '2026-08-01T00:00:00.000Z'},
    {webcamId: 'cam-1', type: 'stream', status: 'online', changedOn: '2026-08-01T03:30:00.000Z'},
    {webcamId: 'cam-2', type: 'stream', status: 'offline', changedOn: '2026-08-02T00:00:00.000Z'},
    {webcamId: 'cam-2', type: 'stream', status: 'online', changedOn: '2026-08-02T01:00:00.000Z'},
  ]

  const result = handleWebcamgoChat({
    message: 'Elencami le webcam offline per più di due ore nell’ultimo mese.',
    webcams,
    statusLogs,
    now,
  })

  assert.equal(result.intent, 'webcam-outage-history')
  assert.equal(result.data.totale, 1)
  assert.equal(result.data.items[0].id, 'cam-1')
  assert.equal(result.data.items[0].longestDurationMs, 3.5 * 60 * 60 * 1000)
})

test('analizza anomalie ricorrenti, unisce gli stati simultanei e trova fattori comuni', () => {
  const now = new Date('2026-08-12T12:00:00.000Z')
  const first = webcam('cam-a', 'Gallio Uno', 'gallio-uno', 'Gallio')
  const second = webcam('cam-b', 'Gallio Due', 'gallio-due', 'Gallio')
  const occasional = webcam('cam-c', 'Asiago Uno', 'asiago-uno', 'Asiago')
  first.networkProvider = 'EOLO'
  second.networkProvider = 'EOLO'
  occasional.networkProvider = 'TIM'
  first.hardware = {brand: 'Axis', model: 'M1'}
  second.hardware = {brand: 'Axis', model: 'M2'}
  occasional.hardware = {brand: 'Hikvision', model: 'H1'}

  const incident = (webcamId, type, startedAt, endedAt) => [
    {webcamId, type, status: 'offline', changedOn: startedAt},
    {webcamId, type, status: 'online', changedOn: endedAt},
  ]
  const statusLogs = [
    ...incident('cam-a', 'stream', '2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'),
    ...incident('cam-a', 'snapshot', '2026-06-01T10:01:00.000Z', '2026-06-01T10:40:00.000Z'),
    ...incident('cam-a', 'stream', '2026-07-01T10:00:00.000Z', '2026-07-01T12:00:00.000Z'),
    ...incident('cam-b', 'stream', '2026-06-10T10:00:00.000Z', '2026-06-10T11:00:00.000Z'),
    ...incident('cam-b', 'stream', '2026-07-10T10:00:00.000Z', '2026-07-10T11:30:00.000Z'),
    ...incident('cam-c', 'stream', '2026-07-15T10:00:00.000Z', '2026-07-15T11:00:00.000Z'),
  ]

  const result = handleWebcamgoChat({
    message: 'Quali webcam hanno avuto anomalie ricorrenti negli ultimi tre mesi e cosa hanno in comune?',
    webcams: [first, second, occasional],
    statusLogs,
    now,
  })

  assert.equal(result.intent, 'webcam-anomaly-analysis')
  assert.equal(result.data.totale, 2)
  assert.deepEqual(result.data.items.map(item => item.id), ['cam-a', 'cam-b'])
  assert.equal(result.data.items[0].incidentCount, 2)
  assert.deepEqual(result.data.items[0].affectedTypes, ['snapshot', 'stream'])
  assert.ok(result.data.commonFactors.some(factor =>
    factor.field === 'networkProvider' && factor.value === 'EOLO' && factor.count === 2
  ))
  assert.match(result.reply, /correlazioni descrittive, non cause dimostrate/i)
})

test('l’analisi storica limita il fetch al periodo richiesto e usa una sintesi amministrativa', () => {
  const now = new Date('2026-08-12T12:00:00.000Z')
  const request = parseWebcamHistoryRequest(
    'Mostrami le prime cinque webcam con anomalie ricorrenti negli ultimi tre mesi',
    now
  )

  assert.equal(request.type, 'recurring-anomalies')
  assert.equal(request.limit, 5)
  assert.equal(request.fetchSince.toISOString(), request.since.toISOString())
})

test('ricostruisce una anomalia iniziata prima della finestra dal primo ritorno online', () => {
  const now = new Date('2026-08-12T12:00:00.000Z')
  const affected = webcam('cam-boundary', 'Confine periodo', 'confine-periodo')
  const result = handleWebcamgoChat({
    message: 'Quali webcam hanno avuto anomalie ricorrenti negli ultimi tre mesi?',
    webcams: [affected],
    statusLogs: [
      {webcamId: 'cam-boundary', type: 'stream', status: 'online', changedOn: '2026-06-01T03:00:00.000Z'},
      {webcamId: 'cam-boundary', type: 'stream', status: 'offline', changedOn: '2026-07-01T10:00:00.000Z'},
      {webcamId: 'cam-boundary', type: 'stream', status: 'online', changedOn: '2026-07-01T11:00:00.000Z'},
    ],
    now,
  })

  assert.equal(result.data.totale, 1)
  assert.equal(result.data.items[0].incidentCount, 2)
  assert.equal(result.data.items[0].incidents[0].startedAt, '2026-05-12T12:00:00.000Z')
})

test('recupera l’ultimo offline della webcam ricordata dalla conversazione', () => {
  const result = handleWebcamgoChat({
    message: 'ultimo stato offline',
    webcams,
    history: [{role: 'assistant', data: {type: 'webcam-detail', item: {slug: 'le-melette'}}}],
    statusLogs: [
      {webcamId: 'cam-1', type: 'stream', status: 'offline', changedOn: '2026-08-10T10:00:00.000Z'},
    ],
  })

  assert.equal(result.intent, 'webcam-latest-offline')
  assert.equal(result.data.item.id, 'cam-1')
  assert.equal(result.data.event.type, 'stream')
})
