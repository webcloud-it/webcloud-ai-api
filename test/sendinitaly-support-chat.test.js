import assert from 'node:assert/strict'
import test from 'node:test'

import {handleSupportChat} from '../src/modules/facile/sendinitaly/supportChat.js'

function services(overrides = {}) {
  return {
    getUsers: async () => ({data: []}),
    getSupportTickets: async () => ({data: [], meta: {total: 0}}),
    getSupportTicket: async () => ({data: {}}),
    createSupportTicket: async () => ({data: {id: 99}}),
    addSupportTicketArticle: async () => ({data: {id: 8}}),
    updateSupportTicket: async () => ({data: {id: 42}}),
    escalateSupportTicket: async () => ({data: {task_id: 'task-1'}}),
    ...overrides,
  }
}

function ticket(overrides = {}) {
  return {
    id: 42,
    number: '42001',
    title: 'Problema dominio',
    state: 'open',
    priority: '2 normal',
    category: 'deliverability',
    customer_id: 'u1',
    customer: {company_name: 'Acme'},
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
    last_contact_customer_at: '2026-09-01T10:00:00Z',
    last_contact_agent_at: null,
    ...overrides,
  }
}

test('filters support tickets by state and priority without model calculations', async () => {
  const result = await handleSupportChat({
    message: 'Elenca i ticket aperti con priorità alta',
    token: 'token',
    services: services({
      getSupportTickets: async () => ({data: [ticket({priority: '3 high'}), ticket({id: 43, priority: '2 normal'})], meta: {total: 2}}),
    }),
  })
  assert.equal(result.data.total, 1)
  assert.equal(result.data.items[0].id, 42)
})

test('counts unanswered tickets older than a requested threshold', async () => {
  const result = await handleSupportChat({
    message: 'Quanti ticket sono senza risposta da più di 2 giorni?',
    token: 'token',
    services: services({
      getSupportTickets: async () => ({data: [
        ticket({last_contact_customer_at: '2026-09-01T10:00:00Z'}),
        ticket({id: 43, last_contact_customer_at: '2026-09-06T10:00:00Z'}),
      ], meta: {total: 2}}),
    }),
  })
  assert.equal(result.intent, 'sendinitaly-support-analysis')
  assert.equal(result.data.total, 1)
  assert.match(result.reply, /1 ticket/)
})

test('ranks customers by ticket count on the complete loaded dataset', async () => {
  const result = await handleSupportChat({
    message: 'Quali clienti hanno più ticket aperti?',
    token: 'token',
    services: services({
      getSupportTickets: async () => ({data: [
        ticket(),
        ticket({id: 43}),
        ticket({id: 44, customer_id: 'u2', customer: {company_name: 'Beta'}}),
      ], meta: {total: 3}}),
    }),
  })
  assert.deepEqual(result.data.analysis.ranking[0], {label: 'Acme', count: 2})
  assert.match(result.reply, /Acme: 2 ticket/)
})

test('groups ticket distribution by category', async () => {
  const result = await handleSupportChat({
    message: 'Mostrami la distribuzione dei ticket per categoria',
    token: 'token',
    services: services({getSupportTickets: async () => ({data: [ticket(), ticket({id: 43, category: 'billing'})], meta: {total: 2}})}),
  })
  assert.equal(result.data.analysis.dimension, 'category')
  assert.equal(result.data.analysis.ranking.length, 2)
})

test('filters tickets in a relative time range', async () => {
  const result = await handleSupportChat({
    message: 'Elenca i ticket aggiornati nell’ultimo mese',
    token: 'token',
    services: services({getSupportTickets: async () => ({data: [ticket(), ticket({id: 43, updated_at: '2026-01-01T00:00:00Z'})], meta: {total: 2}})}),
  })
  assert.equal(result.data.total, 1)
})

test('reads ticket conversation and sanitizes the article history', async () => {
  const result = await handleSupportChat({
    message: 'Mostrami la conversazione del ticket #42001',
    token: 'token',
    services: services({
      getSupportTickets: async () => ({data: [ticket()], meta: {total: 1}}),
      getSupportTicket: async () => ({data: {ticket: ticket(), articles: [{id: 1, body: 'Buongiorno', sender: 'Customer', created_at: '2026-09-01T10:00:00Z'}]}}),
    }),
  })
  assert.equal(result.intent, 'sendinitaly-support-ticket-detail')
  assert.equal(result.data.articles[0].body, 'Buongiorno')
})

test('latest reply is a read request, never a mutation', async () => {
  let mutated = false
  const result = await handleSupportChat({
    message: 'Qual è l’ultima risposta del ticket #42001?',
    token: 'token',
    services: services({
      getSupportTickets: async () => ({data: [ticket()], meta: {total: 1}}),
      getSupportTicket: async () => ({data: {ticket: ticket(), articles: [{id: 1, body: 'Prima'}, {id: 2, body: 'Ultima'}]}}),
      addSupportTicketArticle: async () => { mutated = true },
    }),
  })
  assert.equal(result.data.articles.length, 1)
  assert.equal(result.data.articles[0].body, 'Ultima')
  assert.equal(mutated, false)
})

test('reply requires preview and explicit confirmation', async () => {
  let call
  const mocked = services({
    getSupportTickets: async () => ({data: [ticket()], meta: {total: 1}}),
    addSupportTicketArticle: async options => { call = options; return {data: {id: 8}} },
  })
  const preview = await handleSupportChat({message: 'Rispondi al ticket #42001: Abbiamo corretto la configurazione.', token: 'token-a', services: mocked})
  assert.equal(preview.data.type, 'action-proposal')
  assert.equal(call, undefined)
  const result = await handleSupportChat({message: 'confermo', token: 'token-a', history: [{data: preview.data}], services: mocked})
  assert.equal(result.intent, 'support-action-result')
  assert.equal(call.internal, false)
  assert.match(call.body, /corretto/)
})

test('internal note can be cancelled without changing Zammad', async () => {
  let calls = 0
  const mocked = services({
    getSupportTickets: async () => ({data: [ticket()], meta: {total: 1}}),
    addSupportTicketArticle: async () => { calls += 1 },
  })
  const preview = await handleSupportChat({message: 'Aggiungi nota interna al ticket #42001: Verificare con il tecnico.', token: 'token-b', services: mocked})
  const result = await handleSupportChat({message: 'annulla', token: 'token-b', history: [{data: preview.data}], services: mocked})
  assert.equal(result.intent, 'action-cancelled')
  assert.equal(calls, 0)
})

test('escalation is proposed only by an explicit action verb', async () => {
  const read = await handleSupportChat({
    message: 'Quali ticket hanno escalation ClickUp?', token: 'token',
    services: services({getSupportTickets: async () => ({data: [ticket({clickup_task_id: 'task-1'})], meta: {total: 1}})}),
  })
  assert.notEqual(read.data.type, 'action-proposal')

  const preview = await handleSupportChat({
    message: 'Crea escalation ClickUp per il ticket #42001', token: 'token',
    services: services({getSupportTickets: async () => ({data: [ticket()], meta: {total: 1}})}),
  })
  assert.equal(preview.data.operation, 'support-escalate')
})

test('closing a ticket produces a verified state-change preview', async () => {
  const preview = await handleSupportChat({
    message: 'Chiudi il ticket #42001', token: 'token',
    services: services({getSupportTickets: async () => ({data: [ticket()], meta: {total: 1}})}),
  })
  assert.equal(preview.data.operation, 'support-update')
  assert.deepEqual(preview.data.changes[0], {label: 'Stato', from: 'open', to: 'closed'})
})

test('changing priority executes only after confirmation', async () => {
  let update
  const mocked = services({
    getSupportTickets: async () => ({data: [ticket()], meta: {total: 1}}),
    updateSupportTicket: async options => { update = options; return {data: ticket({priority: '3 high'})} },
  })
  const preview = await handleSupportChat({message: 'Imposta priorità alta al ticket #42001', token: 'token-c', services: mocked})
  await handleSupportChat({message: 'confermo', token: 'token-c', history: [{data: preview.data}], services: mocked})
  assert.equal(update.priority, 'high')
})

test('a proposal cannot be confirmed by another authenticated session', async () => {
  let calls = 0
  const mocked = services({
    getSupportTickets: async () => ({data: [ticket()], meta: {total: 1}}),
    updateSupportTicket: async () => { calls += 1 },
  })
  const preview = await handleSupportChat({message: 'Chiudi il ticket #42001', token: 'owner-token', services: mocked})
  const result = await handleSupportChat({message: 'confermo', token: 'other-token', history: [{data: preview.data}], services: mocked})
  assert.equal(result.intent, 'action-error')
  assert.equal(calls, 0)
})

test('ticket creation resolves the customer and requires full content', async () => {
  const mocked = services({getUsers: async () => ({data: [{id: 'u1', company_name: 'Acme'}]})})
  const clarification = await handleSupportChat({message: 'Crea ticket per il cliente Acme', token: 'token', services: mocked})
  assert.equal(clarification.intent, 'clarification')
  const preview = await handleSupportChat({message: 'Crea ticket per il cliente Acme: Dominio non verificato - Il dominio mittente non supera il controllo SPF.', token: 'token', services: mocked})
  assert.equal(preview.data.operation, 'support-create')
})

test('ticket creation preserves customer, category and content on confirmation', async () => {
  let creation
  const mocked = services({
    getUsers: async () => ({data: [{id: 'u1', company_name: 'Acme'}]}),
    createSupportTicket: async options => { creation = options; return {data: {id: 99}} },
  })
  const preview = await handleSupportChat({message: 'Crea ticket fatturazione per il cliente Acme: Fattura non ricevuta - Il cliente non trova la fattura di agosto.', token: 'token-d', services: mocked})
  await handleSupportChat({message: 'confermo', token: 'token-d', history: [{data: preview.data}], services: mocked})
  assert.equal(creation.customerId, 'u1')
  assert.equal(creation.category, 'billing')
  assert.equal(creation.title, 'Fattura non ricevuta')
})

test('loads additional pages before calculating an aggregate', async () => {
  const pages = []
  const first = Array.from({length: 50}, (_, index) => ticket({id: index + 1, number: String(1000 + index)}))
  const result = await handleSupportChat({
    message: 'Quanti ticket di assistenza ci sono?', token: 'token',
    services: services({getSupportTickets: async ({page}) => {
      pages.push(page)
      return page === 1 ? {data: first, meta: {total: 51}} : {data: [ticket({id: 99})], meta: {total: 51}}
    }}),
  })
  assert.deepEqual(pages, [1, 2])
  assert.equal(result.data.total, 51)
})

test('does not reuse a CRM customer scope for support filtering', async () => {
  let customerId
  await handleSupportChat({
    message: 'Mostrami i ticket di assistenza', token: 'token',
    context: {activeModuleId: 'facile.renewals', section: 'crm.renewals', scope: {customerId: 'crm-1'}},
    services: services({getSupportTickets: async options => { customerId = options.customerId; return {data: [], meta: {total: 0}} }}),
  })
  assert.equal(customerId, '')
})
