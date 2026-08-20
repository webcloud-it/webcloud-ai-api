import test from 'node:test'
import assert from 'node:assert/strict'

import {handleSendInItalyChat} from '../src/modules/facile/sendinitaly/chat.js'

function mockServices(overrides = {}) {
  return {
    getUsers: async () => ({data: []}),
    getUser: async () => ({data: {}}),
    getUserPlans: async () => ({data: []}),
    getUserDnsStatus: async () => ({data: {}}),
    getCampaigns: async () => ({data: [], meta: {total: 0}}),
    getCampaignStats: async () => ({data: {}}),
    ...overrides,
  }
}

test('lists Send in Italy plans through the dedicated endpoint', async () => {
  const result = await handleSendInItalyChat({
    message: 'Quali piani utenti Send in Italy sono disponibili?',
    token: 'token',
    services: mockServices({getUserPlans: async () => ({data: [{id: 'pro', name: 'Pro'}]})}),
  })
  assert.equal(result.intent, 'sendinitaly-plans')
  assert.match(result.reply, /Pro/)
})

test('returns a sanitized Send in Italy user detail', async () => {
  const result = await handleSendInItalyChat({
    message: 'Mostra il dettaglio utente "Acme"',
    token: 'token',
    services: mockServices({
      getUsers: async () => ({data: [{id: 'u1', company_name: 'Acme'}]}),
      getUser: async () => ({data: {id: 'u1', company_name: 'Acme', total_contacts: 42, customer_raw: {password: 'secret'}, sender_domains: ['mail.acme.it']}}),
    }),
  })
  assert.equal(result.intent, 'sendinitaly-user-detail')
  assert.equal(result.data.user.counts.contacts, 42)
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('apre un utente Send in Italy quando il nome è univoco', async () => {
  const result = await handleSendInItalyChat({
    message: 'apri il cliente Acme',
    token: 'token',
    services: mockServices({
      getUsers: async () => ({data: [{id: 'u1', company_name: 'Acme'}]}),
    }),
  })

  assert.equal(result.intent, 'app-action')
  assert.equal(result.data.appAction.path, '/sendinitaly/users/u1')
})

test('propone solo gli utenti Send in Italy ambigui', async () => {
  const result = await handleSendInItalyChat({
    message: 'apri il cliente Acme',
    token: 'token',
    services: mockServices({
      getUsers: async () => ({data: [
        {id: 'u1', company_name: 'Acme Italia'},
        {id: 'u2', company_name: 'Acme Europa'},
      ]}),
    }),
  })

  assert.equal(result.intent, 'sendinitaly-user-open-ambiguous')
  assert.equal(result.data.type, 'sendinitaly-users')
  assert.equal(result.data.data.length, 2)
})

test('checks sender DNS domains and isolates per-domain failures', async () => {
  const result = await handleSendInItalyChat({
    message: 'Verifica DNS dell’utente "Acme"',
    token: 'token',
    services: mockServices({
      getUsers: async () => ({data: [{id: 'u1', company_name: 'Acme'}]}),
      getUser: async () => ({data: {id: 'u1', company_name: 'Acme', sender_domains: ['ok.it', 'ko.it']}}),
      getUserDnsStatus: async ({domain}) => {
        if (domain === 'ko.it') throw new Error('temporaneamente non disponibile')
        return {data: {found: true, status: 'configured', checks: {spf: true, click2: true, ss1rp: true}}}
      },
    }),
  })
  assert.equal(result.intent, 'sendinitaly-dns-status')
  assert.equal(result.data.items.length, 2)
  assert.equal(result.data.items.find(item => item.domain === 'ko.it').status, 'error')
})

test('checks sender DNS domains across all users when no user is named', async () => {
  const checked = []
  const result = await handleSendInItalyChat({
    message: 'Controlla i domini mittente di Send in Italy',
    token: 'token',
    services: mockServices({
      getUsers: async () => ({data: [
        {id: 'u1', company_name: 'Acme'},
        {id: 'u2', company_name: 'Beta'},
      ]}),
      getUser: async ({userId}) => ({data: {
        id: userId,
        company_name: userId === 'u1' ? 'Acme' : 'Beta',
        sender_domains: userId === 'u1' ? ['mail.acme.it'] : ['mail.beta.it'],
      }}),
      getUserDnsStatus: async ({userId, domain}) => {
        checked.push([userId, domain])
        return {data: {found: true, status: 'configured', checks: {spf: true, click2: true, ss1rp: true}}}
      },
    }),
  })

  assert.equal(result.intent, 'sendinitaly-dns-status')
  assert.equal(result.data.scope, 'all-users')
  assert.equal(result.data.items.length, 2)
  assert.equal(result.data.items[0].companyName, 'Acme')
  assert.deepEqual(checked, [['u1', 'mail.acme.it'], ['u2', 'mail.beta.it']])
})

test('checks a named sender DNS user without requiring an entity keyword', async () => {
  const result = await handleSendInItalyChat({
    message: 'Controlla lo stato DNS di Acme',
    token: 'token',
    services: mockServices({
      getUsers: async ({search}) => {
        assert.equal(search, 'Acme')
        return {data: [{id: 'u1', company_name: 'Acme'}]}
      },
      getUser: async () => ({data: {id: 'u1', company_name: 'Acme', sender_domains: ['mail.acme.it']}}),
      getUserDnsStatus: async () => ({data: {found: true, status: 'configured', checks: {spf: true, click2: true, ss1rp: true}}}),
    }),
  })

  assert.equal(result.data.scope, undefined)
  assert.equal(result.data.user.companyName, 'Acme')
})
