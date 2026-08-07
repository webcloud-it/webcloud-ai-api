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
