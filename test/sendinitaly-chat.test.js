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
