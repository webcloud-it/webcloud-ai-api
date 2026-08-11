import test from 'node:test'
import assert from 'node:assert/strict'

import {attachChatPresentation, buildChatPresentation} from '../src/core/presentation/chatPresentation.js'

test('builds navigable Send in Italy user cards without copying raw fields', () => {
  const presentation = buildChatPresentation({
    type: 'sendinitaly-users',
    meta: {total: 1},
    data: [{id: 'customer-1', company_name: 'Acme', total_contacts: 42, internal_secret: 'never-copy'}],
  })

  assert.equal(presentation.kind, 'list')
  assert.equal(presentation.cards[0].title, 'Acme')
  assert.equal(presentation.cards[0].action.path, '/sendinitaly/users/customer-1')
  assert.equal(JSON.stringify(presentation).includes('never-copy'), false)
})

test('builds WebcamGo metrics and list cards with internal navigation', () => {
  const metrics = buildChatPresentation({type: 'webcam-summary', summary: {total: 10, online: 8, offline: 2}})
  assert.equal(metrics.kind, 'metrics')
  assert.equal(metrics.metrics.find(item => item.label === 'Online').value, '8')

  const cards = buildChatPresentation({
    type: 'webcam-list',
    totale: 1,
    items: [{id: '1', name: 'Piazza', slug: 'piazza', status: {overall: 'online', stream: {status: 'online'}}}],
  })
  assert.equal(cards.cards[0].action.path, '/webcamgo/webcams/piazza')
})

test('decorates renewals lists while preserving the original response contract', () => {
  const original = {ok: true, data: {type: 'critical-services', totale: 1, items: [{servizio: 'example.it', cliente: 'Acme', priorita: 'alta', msg: 'Rinnovo urgente'}]}}
  const decorated = attachChatPresentation(original)

  assert.equal(decorated.data.items, original.data.items)
  assert.equal(decorated.data.presentation.cards[0].title, 'example.it')
  assert.equal(decorated.data.presentation.cards[0].badge, 'alta')
  assert.equal(decorated.data.actions[0].path, '/crm/renewals/panel')
})

test('does not decorate unknown payloads', () => {
  const original = {ok: true, data: {type: 'custom', password: 'do-not-render'}}
  assert.equal(attachChatPresentation(original), original)
})

test('builds a confirmation card without exposing opaque proposal tokens', () => {
  const presentation = buildChatPresentation({
    type: 'action-proposal',
    operation: 'webcam-reboot',
    proposalToken: 'opaque-secret-token',
    confirmationRequired: true,
    target: {id: 'cam-1', name: 'Piazza'},
  })

  assert.equal(presentation.kind, 'proposal')
  assert.equal(presentation.target, 'Piazza')
  assert.deepEqual(presentation.actions.map(item => item.message), ['confermo', 'annulla'])
  assert.equal(JSON.stringify(presentation).includes('opaque-secret-token'), false)
})

test('renders renewals changes in a generic confirmation card', () => {
  const presentation = buildChatPresentation({
    type: 'action-preview',
    action: {
      tool: 'renew-service',
      requiresConfirmation: true,
      target: {label: 'example.it'},
      changes: [{field: 'endDate', from: '2026-01-01', to: '2027-01-01'}],
    },
  })

  assert.equal(presentation.kind, 'proposal')
  assert.equal(presentation.changes[0].label, 'endDate')
  assert.equal(presentation.changes[0].to, '2027-01-01')
})

test('builds structured DNS cards for Send in Italy', () => {
  const presentation = buildChatPresentation({
    type: 'sendinitaly-dns-status',
    user: {companyName: 'Acme'},
    items: [{domain: 'mail.acme.it', status: 'configured', checks: {spf: true, click2: true, ss1rp: false}}],
  })

  assert.equal(presentation.kind, 'list')
  assert.equal(presentation.cards[0].badge, 'configured')
  assert.equal(presentation.cards[0].details[2].value, 'da verificare')
})

test('builds navigable Asiago event and minisite cards', () => {
  const events = buildChatPresentation({
    type: 'asiago-events',
    total: 1,
    items: [{id: 42, title: 'Festa del Bosco', published: true, event: {startDate: '2026-08-20'}}],
  })
  assert.equal(events.cards[0].action.path, '/asiagoit/events/42')
  assert.equal(events.cards[0].badge, 'pubblicato')

  const minisites = buildChatPresentation({
    type: 'asiago-minisites',
    total: 1,
    items: [{id: 9, name: 'Hotel Europa', category: {name: 'Hotel'}}],
  })
  assert.equal(minisites.cards[0].action.path, '/asiagoit/minisites/9')
  assert.equal(minisites.cards[0].subtitle, 'Hotel')
})

test('builds Asiago summary metrics', () => {
  const presentation = buildChatPresentation({
    type: 'asiago-summary',
    totals: {upcomingEvents: 4, contents: 100, minisites: 12},
  })
  assert.equal(presentation.kind, 'metrics')
  assert.equal(presentation.metrics[0].value, '4')
})

test('builds safe snow bulletin and redirect cards', () => {
  const snow = buildChatPresentation({
    type: 'asiago-snow-resorts',
    total: 1,
    items: [{id: 'r1', name: 'Kaberlaba', location: 'Asiago', portalVisible: true, notificationsEnabled: true, integrations: {enabled: 2, total: 2}, apiKey: 'must-not-render'}],
  })
  assert.equal(snow.cards[0].badge, 'portale attivo')
  assert.equal(JSON.stringify(snow).includes('must-not-render'), false)

  const redirects = buildChatPresentation({
    type: 'asiago-redirects',
    total: 1,
    items: [{id: 1, fromPath: '/vecchia', toUrl: '/nuova', autogenerated: false, visits: 12}],
  })
  assert.equal(redirects.cards[0].title, '/vecchia')
  assert.equal(redirects.cards[0].details[0].value, '12')
})

test('builds safe Webcloud tool cards', () => {
  const cache = buildChatPresentation({type: 'webcloud-cache-buckets', total: 1, items: [{name: 'asiago', pattern: '/images/*', cdnMaxAge: 3600}]})
  assert.equal(cache.cards[0].title, 'asiago')

  const automation = buildChatPresentation({type: 'webcloud-automations', total: 1, items: [{id: 'a1', name: 'Pubblica', runnable: true, inputs: [{name: 'Titolo'}], triggerUrl: 'must-not-render'}]})
  assert.equal(automation.cards[0].action.path, '/webcloud/mattemations/a1')
  assert.equal(JSON.stringify(automation).includes('must-not-render'), false)

  const asset = buildChatPresentation({type: 'webcloud-wam-assets', total: 1, items: [{id: 1, shortId: 'abc12345', title: 'Foto', applicationId: 'app-1', width: 100, height: 50}]})
  assert.equal(asset.cards[0].action.query.asset, 'abc12345')
})

test('builds chatbot audit metrics', () => {
  const presentation = buildChatPresentation({type: 'webcloud-chat-audit', requests: 12, successRate: 91.7, failures: 1, averageDurationMs: 420, slowRequests: 0})
  assert.equal(presentation.kind, 'metrics')
  assert.equal(presentation.metrics[0].value, '12')
  assert.equal(presentation.metrics[1].value, '91.7%')
})

test('builds operational overview cards', () => {
  const presentation = buildChatPresentation({type: 'webcloud-operational-overview', sources: [{id: 'webcamgo', label: 'WebcamGo', ok: true, metrics: {online: 12, unexpectedOffline: 1}, alerts: [{level: 'high', label: 'offline'}], action: {id: 'navigate', label: 'Apri', path: '/webcamgo'}}]})
  assert.equal(presentation.kind, 'list')
  assert.equal(presentation.cards[0].badge, 'attenzione')
  assert.equal(presentation.cards[0].action.path, '/webcamgo')
})
