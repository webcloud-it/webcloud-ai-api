import assert from 'node:assert/strict'
import test from 'node:test'

import {handleSupportChat} from '../src/modules/facile/sendinitaly/supportChat.js'
import {analyzeSupportResolution, redactSupportText, stripTechnicalContext} from '../src/modules/facile/sendinitaly/supportAdvisor.js'

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

test('treats natural open tickets as every unresolved Zammad state', async () => {
  const result = await handleSupportChat({
    message: 'Quanti ticket aperti ci sono?',
    token: 'token',
    services: services({
      getSupportTickets: async () => ({data: [
        ticket({state: 'new'}),
        ticket({id: 43, state: 'open'}),
        ticket({id: 44, state: 'pending'}),
        ticket({id: 45, state: 'closed'}),
      ], meta: {total: 4}}),
    }),
  })
  assert.equal(result.data.total, 3)
  assert.match(result.reply, /3 ticket/)
  assert.match(result.reply, /non chiusi/)
})

test('counts unanswered tickets older than a requested threshold', async () => {
  const result = await handleSupportChat({
    message: 'Quanti ticket sono senza risposta da più di 2 giorni?',
    token: 'token',
    services: services({
      getSupportTickets: async () => ({data: [
        ticket({last_contact_customer_at: '2026-09-01T10:00:00Z'}),
        ticket({id: 43, last_contact_customer_at: '2026-09-07T10:00:00Z'}),
      ], meta: {total: 2}}),
    }),
  })
  assert.equal(result.intent, 'sendinitaly-support-analysis')
  assert.equal(result.data.total, 1)
  assert.match(result.reply, /1 ticket/)
})

test('understands an age threshold written in Italian words', async () => {
  const result = await handleSupportChat({
    message: 'Quali ticket sono senza risposta da più di due giorni?', token: 'token',
    services: services({getSupportTickets: async () => ({data: [
      ticket({id: 1, last_contact_customer_at: '2026-09-01T10:00:00Z'}),
      ticket({id: 2, last_contact_customer_at: new Date().toISOString()}),
    ], meta: {total: 2}})}),
  })
  assert.equal(result.data.total, 1)
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

test('compares the first two customers using a deterministic complete-data ranking', async () => {
  const result = await handleSupportChat({
    message: 'Confronta i primi due clienti per numero di ticket.',
    token: 'token',
    services: services({
      getSupportTickets: async () => ({data: [
        ticket(),
        ticket({id: 43}),
        ticket({id: 44, customer_id: 'u2', customer: {company_name: 'Beta'}}),
      ], meta: {total: 3}}),
    }),
  })
  assert.equal(result.data.analysis.operation, 'compare')
  assert.deepEqual(result.data.analysis.comparison, {
    first: {label: 'Acme', count: 2},
    second: {label: 'Beta', count: 1},
    difference: 1,
  })
  assert.match(result.reply, /Confronto: Acme ha 2 ticket, Beta ne ha 1; differenza 1/i)
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

test('recognizes the singular Italian detail request with a public ticket number', async () => {
  const result = await handleSupportChat({
    message: 'Mostrami il dettaglio del ticket 42001',
    token: 'token',
    services: services({
      getSupportTickets: async () => ({data: [ticket()], meta: {total: 1}}),
      getSupportTicket: async () => ({data: {ticket: ticket(), articles: []}}),
    }),
  })
  assert.equal(result.intent, 'sendinitaly-support-ticket-detail')
  assert.equal(result.data.ticket.number, '42001')
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

test('treats tickets da gestire as unresolved tickets awaiting an operator reply', async () => {
  const result = await handleSupportChat({
    message: 'Quanti ticket sono da gestire?', token: 'token',
    services: services({getSupportTickets: async () => ({data: [
      ticket({id: 1, state: 'new', last_contact_customer_at: '2026-09-07T10:00:00Z', last_contact_agent_at: null}),
      ticket({id: 2, state: 'open', last_contact_customer_at: '2026-09-07T10:00:00Z', last_contact_agent_at: '2026-09-07T11:00:00Z'}),
      ticket({id: 3, state: 'closed', last_contact_customer_at: '2026-09-07T10:00:00Z', last_contact_agent_at: null}),
    ], meta: {total: 3}})}),
  })
  assert.equal(result.data.total, 1)
  assert.equal(result.data.filters.needsAttention, true)
  assert.match(result.reply, /1 ticket/)
})

test('identifies who opened the latest ticket using creation time, not update time', async () => {
  const result = await handleSupportChat({
    message: 'Chi ha mandato l’ultimo ticket?', token: 'token',
    services: services({getSupportTickets: async () => ({data: [
      ticket({id: 1, number: '1001', customer: {company_name: 'Vecchio'}, created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-08T10:00:00Z'}),
      ticket({id: 2, number: '1002', customer: {company_name: 'Recente'}, created_at: '2026-09-07T10:00:00Z', updated_at: '2026-09-07T10:00:00Z'}),
    ], meta: {total: 2}})}),
  })
  assert.equal(result.intent, 'sendinitaly-support-ticket-actor')
  assert.equal(result.data.ticket.number, '1002')
  assert.match(result.reply, /Recente/)
})

test('reports the recorded resolver of a closed ticket', async () => {
  const result = await handleSupportChat({
    message: 'Chi ha risolto il ticket #42001?', token: 'token',
    services: services({
      getSupportTickets: async () => ({data: [ticket({state: 'closed'})], meta: {total: 1}}),
      getSupportTicket: async () => ({data: {
        ticket: ticket({state: 'closed', resolved_by: 'Mario Rossi', closed_at: '2026-09-07T12:00:00Z'}),
        articles: [],
        resolution: {actor: 'Mario Rossi', at: '2026-09-07T12:00:00Z', basis: 'closing-update', inferred: false},
      }}),
    }),
  })
  assert.match(result.reply, /Mario Rossi/)
  assert.equal(result.data.resolution.inferred, false)
})

test('explains that an open ticket has no resolver yet', async () => {
  const result = await handleSupportChat({
    message: 'Chi ha risolto il ticket #42001?', token: 'token',
    services: services({
      getSupportTickets: async () => ({data: [ticket()], meta: {total: 1}}),
      getSupportTicket: async () => ({data: {ticket: ticket(), articles: []}}),
    }),
  })
  assert.match(result.reply, /non risulta chiuso/i)
})

test('builds a grounded resolution plan and reply draft from the ticket conversation', async () => {
  const result = await handleSupportChat({
    message: 'Come va risolto il ticket #42001?', token: 'token',
    services: services({
      getSupportTickets: async () => ({data: [ticket()], meta: {total: 1}}),
      getSupportTicket: async () => ({data: {ticket: ticket(), articles: [{id: 1, sender: 'Customer', body: 'SPF non valido'}]}}),
      analyzeSupportResolution: async () => ({
        summary: 'Il cliente segnala un controllo SPF non valido.',
        customerRequest: 'Correggere SPF', hypotheses: ['Record SPF incompleto'],
        steps: ['Leggere il record DNS effettivo', 'Confrontarlo con il valore richiesto'],
        missingInformation: ['Dominio mittente'], suggestedReply: 'Buongiorno, verifichiamo il record SPF del dominio mittente.',
        confidence: 'medium', risks: [], modelUsed: true,
      }),
    }),
  })
  assert.equal(result.intent, 'sendinitaly-support-resolution-advice')
  assert.match(result.reply, /Piano consigliato/)
  assert.match(result.reply, /Bozza di risposta/)
  assert.equal(result.data.suggestedReply, 'Buongiorno, verifichiamo il record SPF del dominio mittente.')
})

test('uses the support ticket opened in Facile when the request omits its number', async () => {
  let requestedTicketId
  const result = await handleSupportChat({
    message: 'Come va risolto questo ticket?', token: 'token',
    context: {activeEntity: {type: 'support-ticket', id: 42, number: '42001'}},
    services: services({
      getSupportTickets: async () => { throw new Error('list lookup should not be needed') },
      getSupportTicket: async ({ticketId}) => {
        requestedTicketId = ticketId
        return {data: {ticket: ticket(), articles: []}}
      },
      analyzeSupportResolution: async () => ({summary: 'Analisi', customerRequest: 'Richiesta', hypotheses: [], steps: ['Verifica'], missingInformation: [], suggestedReply: 'Bozza', confidence: 'low', risks: [], modelUsed: true}),
    }),
  })
  assert.equal(requestedTicketId, 42)
  assert.equal(result.intent, 'sendinitaly-support-resolution-advice')
})

test('sending a generated draft still requires an explicit confirmation', async () => {
  let calls = 0
  const mocked = services({
    getSupportTickets: async () => ({data: [ticket()], meta: {total: 1}}),
    getSupportTicket: async () => ({data: {ticket: ticket(), articles: []}}),
    analyzeSupportResolution: async () => ({summary: 'Analisi', customerRequest: 'Richiesta', hypotheses: [], steps: ['Verifica'], missingInformation: [], suggestedReply: 'Bozza verificabile', confidence: 'low', risks: [], modelUsed: true}),
    addSupportTicketArticle: async () => { calls += 1; return {data: {id: 9}} },
  })
  const advice = await handleSupportChat({message: 'Prepara una risposta per il ticket #42001', token: 'token', services: mocked})
  const preview = await handleSupportChat({message: 'Invia questa risposta', token: 'token', history: [{data: advice.data}], services: mocked})
  assert.equal(preview.data.type, 'action-proposal')
  assert.equal(preview.data.draft, 'Bozza verificabile')
  assert.equal(calls, 0)
  await handleSupportChat({message: 'confermo', token: 'token', history: [{data: preview.data}], services: mocked})
  assert.equal(calls, 1)
})

test('prepare and send in one request generates a preview instead of mutating Zammad', async () => {
  let calls = 0
  const preview = await handleSupportChat({
    message: 'Prepara e invia una risposta per il ticket #42001', token: 'token',
    services: services({
      getSupportTickets: async () => ({data: [ticket()], meta: {total: 1}}),
      getSupportTicket: async () => ({data: {ticket: ticket(), articles: []}}),
      analyzeSupportResolution: async () => ({summary: 'Analisi', customerRequest: 'Richiesta', hypotheses: [], steps: ['Verifica'], missingInformation: [], suggestedReply: 'Risposta proposta', confidence: 'low', risks: [], modelUsed: true}),
      addSupportTicketArticle: async () => { calls += 1 },
    }),
  })
  assert.equal(preview.data.type, 'action-proposal')
  assert.equal(preview.data.draft, 'Risposta proposta')
  assert.equal(calls, 0)
})

test('redacts credentials before ticket content can reach the model', () => {
  const redacted = redactSupportText('password: hunter2 token=abc123456789 Authorization: secret-value')
  assert.doesNotMatch(redacted, /hunter2|abc123456789|secret-value/)
  assert.match(redacted, /dato sensibile omesso/)
})

test('keeps the automatic technical context out of the customer request', () => {
  const visible = stripTechnicalContext('Il dominio non funziona.\n\n---\nContesto tecnico\nCustomer ID: secret-id')
  assert.equal(visible, 'Il dominio non funziona.')
})

test('support advisor validates structured model output and keeps deterministic playbook steps', async () => {
  let modelInput
  const advice = await analyzeSupportResolution({
    ticket: ticket(),
    articles: [{sender: 'Customer', body: 'La password: hunter2 non funziona'}],
    request: 'Come va risolto?',
    callModel: async input => {
      modelInput = input
      return {summary: 'Accesso non riuscito', customerRequest: 'Ripristinare accesso', hypotheses: [], steps: [], missingInformation: [], suggestedReply: 'Verifichiamo lo stato dell’account.', confidence: 'medium', risks: []}
    },
  })
  assert.equal(advice.modelUsed, true)
  assert.equal(advice.steps.length, 3)
  assert.doesNotMatch(JSON.stringify(modelInput), /hunter2/)
})
