import test from 'node:test'
import assert from 'node:assert/strict'

import {handleSendInItalyChat} from '../src/modules/facile/sendinitaly/chat.js'
import {
  isSendInItalyUserAnalyticsRequest,
  planSendInItalyUserAnalytics,
} from '../src/modules/facile/sendinitaly/userAnalytics.js'

function mockServices(overrides = {}) {
  return {
    getUsers: async () => ({data: []}),
    getUser: async () => ({data: {}}),
    getUserPlans: async () => ({data: []}),
    getUserDnsStatus: async () => ({data: {}}),
    getCampaigns: async () => ({data: [], meta: {total: 0}}),
    getCampaignStats: async () => ({data: {}}),
    getSupportTickets: async () => ({data: [], meta: {total: 0}}),
    getSupportTicket: async () => ({data: {}}),
    createSupportTicket: async () => ({data: {}}),
    addSupportTicketArticle: async () => ({data: {}}),
    updateSupportTicket: async () => ({data: {}}),
    escalateSupportTicket: async () => ({data: {}}),
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

test('interprets generic sending statistics as the last 30 days, not in-process campaigns', async () => {
  let requestedMode
  const result = await handleSendInItalyChat({
    message: 'Quali sono le statistiche di invio degli ultimi 30 giorni?',
    token: 'token',
    services: mockServices({
      getCampaignStats: async ({mode}) => {
        requestedMode = mode
        return {data: {sent: 12}}
      },
    }),
  })

  assert.equal(requestedMode, 'last_30_days')
  assert.equal(result.data.mode, 'last_30_days')
})

test('formats verified campaign rates from backend totals', async () => {
  const result = await handleSendInItalyChat({
    message: 'Qual è il tasso di apertura degli ultimi 30 giorni?',
    token: 'token',
    services: mockServices({
      getCampaignStats: async () => ({
        data: {totals: {shipped: 100, received: 80, opened: 20, clicked: 8, hard_bounce: 5}},
      }),
    }),
  })

  assert.equal(result.intent, 'sendinitaly-stats')
  assert.match(result.reply, /tasso di apertura: 25\.0%/i)
  assert.match(result.reply, /tasso di click: 10\.0%/i)
  assert.match(result.reply, /tasso hard bounce: 5\.0%/i)
})

test('filters users through the canonical Send in Italy plan', async () => {
  let requestedPlan
  const result = await handleSendInItalyChat({
    message: 'Quali utenti hanno il piano Free?',
    token: 'token',
    services: mockServices({
      getUserPlans: async () => ({data: [{id: 'free-id', name: 'SendInItalyFree'}]}),
      getUsers: async options => {
        requestedPlan = options.plan
        return {data: [{id: 'u1', company_name: 'Acme', subscription_config: {plan: {name: 'SendInItalyFree'}}}], meta: {total: 1}}
      },
    }),
  })

  assert.equal(requestedPlan, 'free-id')
  assert.equal(result.intent, 'sendinitaly-users')
  assert.match(result.reply, /piano SendInItalyFree/)
})

test('ranks users by a backend aggregate instead of counting a partial campaign page', async () => {
  let query
  const result = await handleSendInItalyChat({
    message: 'Quale cliente ha creato più campagne?',
    token: 'token',
    services: mockServices({
      getUsers: async options => {
        query = options
        return {data: [{id: 'u1', company_name: 'Acme', total_campaigns: 42}], meta: {total: 11}}
      },
    }),
  })

  assert.equal(query.sortBy, 'campaigns')
  assert.equal(query.sortOrder, 'desc')
  assert.equal(query.limit, 1)
  assert.equal(result.intent, 'sendinitaly-user-ranking')
  assert.match(result.reply, /Acme — 42 campagne/)
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

test('lists support tickets scoped by the active Facile customer', async () => {
  let query
  const result = await handleSendInItalyChat({
    message: 'Mostrami i ticket aperti',
    token: 'token',
    context: {scope: {customerId: 'u1'}},
    services: mockServices({
      getSupportTickets: async options => {
        query = options
        return {
          data: [
            {
              id: 42,
              number: '42001',
              title: 'Dominio non verificato',
              state: 'open',
              customer_id: 'u1',
              customer: {company_name: 'Acme'},
              clickup_task_id: 'task-7',
            },
            {
              id: 43,
              number: '42002',
              title: 'Ticket già risolto',
              state: 'closed',
              customer_id: 'u1',
              customer: {company_name: 'Acme'},
            },
          ],
          meta: {total: 2},
        }
      },
    }),
  })

  assert.equal(result.intent, 'sendinitaly-support-tickets')
  assert.equal(query.customerId, 'u1')
  assert.equal(query.state, '')
  assert.equal(result.data.total, 1)
  assert.equal(result.data.items[0].clickupLinked, true)
  assert.deepEqual(result.data.actions[0].query, {customer_id: 'u1'})
})

test('resolves a named customer before reading its support tickets', async () => {
  let customerId
  const result = await handleSendInItalyChat({
    message: 'Quali ticket di assistenza ha il cliente Acme?',
    token: 'token',
    services: mockServices({
      getUsers: async ({search}) => {
        assert.equal(search, 'Acme')
        return {data: [{id: 'u1', company_name: 'Acme'}]}
      },
      getSupportTickets: async options => {
        customerId = options.customerId
        return {data: [], meta: {total: 0}}
      },
    }),
  })

  assert.equal(result.intent, 'sendinitaly-support-tickets')
  assert.equal(customerId, 'u1')
  assert.match(result.reply, /Acme/)
})

test('does not reuse a CRM page customer id as a Send in Italy customer id', async () => {
  let customerId
  await handleSendInItalyChat({
    message: 'Mostrami i ticket Send in Italy',
    token: 'token',
    context: {
      activeModuleId: 'facile.renewals',
      section: 'crm.renewals',
      scope: {customerId: 'crm-customer-1'},
    },
    services: mockServices({
      getSupportTickets: async options => {
        customerId = options.customerId
        return {data: [], meta: {total: 0}}
      },
    }),
  })

  assert.equal(customerId, '')
})

test('aggregates all Send in Italy users by plan and calculates verified averages', async () => {
  const result = await handleSendInItalyChat({
    message: 'Raggruppa gli utenti per piano e mostrami la media dei contatti',
    token: 'token',
    services: mockServices({
      getUsers: async () => ({
        data: [
          {id: 'u1', company_name: 'Acme', total_contacts: 100, subscription_config: {plan: {name: 'Pro'}}},
          {id: 'u2', company_name: 'Beta', total_contacts: 50, subscription_config: {plan: {name: 'Pro'}}},
          {id: 'u3', company_name: 'Gamma', total_contacts: 10, subscription_config: {plan: {name: 'Free'}}},
        ],
        meta: {total: 3},
      }),
    }),
  })

  assert.equal(result.intent, 'sendinitaly-user-analytics')
  assert.equal(result.data.sourceCount, 3)
  assert.equal(result.data.groups[0].group.plan, 'Pro')
  assert.equal(result.data.groups[0].values.avg_contacts, 75)
  assert.match(result.reply, /3 utenti analizzati/)
})

test('combines multiple numeric filters on the complete user dataset', async () => {
  const result = await handleSendInItalyChat({
    message: 'Elenca i clienti con almeno 100 contatti e più di 5 campagne',
    token: 'token',
    services: mockServices({
      getUsers: async () => ({
        data: [
          {id: 'u1', company_name: 'Acme', total_contacts: 120, total_campaigns: 8},
          {id: 'u2', company_name: 'Beta', total_contacts: 80, total_campaigns: 12},
          {id: 'u3', company_name: 'Gamma', total_contacts: 200, total_campaigns: 2},
        ],
        meta: {total: 3},
      }),
    }),
  })

  assert.equal(result.data.matchedCount, 1)
  assert.equal(result.data.items[0].companyName, 'Acme')
  assert.match(result.reply, /Acme/)
  assert.doesNotMatch(result.reply, /Beta|Gamma/)
})

test('compares top users using backend values and reports deterministic differences', async () => {
  const result = await handleSendInItalyChat({
    message: 'Confronta i primi due clienti per campagne e contatti',
    token: 'token',
    services: mockServices({
      getUsers: async () => ({
        data: [
          {id: 'u1', company_name: 'Acme', total_campaigns: 20, total_contacts: 100},
          {id: 'u2', company_name: 'Beta', total_campaigns: 10, total_contacts: 80},
          {id: 'u3', company_name: 'Gamma', total_campaigns: 2, total_contacts: 500},
        ],
        meta: {total: 3},
      }),
    }),
  })

  assert.equal(result.data.items.length, 2)
  assert.deepEqual(result.data.items.map(item => item.companyName), ['Acme', 'Beta'])
  assert.match(result.reply, /campagne: Acme ha 10 in più \(100%\)/)
  assert.match(result.reply, /contatti: Acme ha 20 in più \(25%\)/)
})

test('paginates the Send in Italy provider so analytics never use only the first page', async () => {
  const requestedPages = []
  const result = await handleSendInItalyChat({
    message: 'Quanti clienti hanno almeno 1 campagna?',
    token: 'token',
    services: mockServices({
      getUsers: async ({page}) => {
        requestedPages.push(page)
        return page === 1
          ? {data: Array.from({length: 250}, (_, index) => ({id: `u${index}`, company_name: `A${index}`, total_campaigns: 1})), meta: {total: 251}}
          : {data: [{id: 'last', company_name: 'Ultimo', total_campaigns: 1}], meta: {total: 251}}
      },
    }),
  })

  assert.deepEqual(requestedPages, [1, 2])
  assert.equal(result.data.sourceCount, 251)
  assert.equal(result.data.matchedCount, 251)
  assert.match(result.reply, /251 utenti/)
})

test('validates semantic Send in Italy plans against the field allowlist', async () => {
  const message = 'Analizza la distribuzione degli account in base al collegamento CRM'
  assert.equal(isSendInItalyUserAnalyticsRequest(message), true)
  const valid = await planSendInItalyUserAnalytics({
    message,
    callModel: async () => ({
      operation: 'aggregate',
      filters: [],
      groupBy: ['crmLinked'],
      metrics: [{id: 'users', function: 'count', field: null}],
      sort: [{field: 'users', direction: 'desc'}],
      limit: 10,
      comparisonFields: [],
    }),
  })
  const unsafe = await planSendInItalyUserAnalytics({
    message,
    callModel: async () => ({
      operation: 'list',
      filters: [{field: 'password', operator: 'contains', value: 'x'}],
      groupBy: [],
      metrics: [],
      sort: [{field: 'password', direction: 'asc'}],
      limit: 10,
      comparisonFields: [],
    }),
  })

  assert.equal(valid.groupBy[0], 'crmLinked')
  assert.equal(unsafe, null)
})

test('refines a previous user analysis without losing its verified ranking context', async () => {
  const services = mockServices({
    getUsers: async () => ({
      data: [
        {id: 'u1', company_name: 'Acme', total_campaigns: 20, total_contacts: 100},
        {id: 'u2', company_name: 'Beta', total_campaigns: 10, total_contacts: 80},
        {id: 'u3', company_name: 'Gamma', total_campaigns: 5, total_contacts: 70},
      ],
      meta: {total: 3},
    }),
  })
  const first = await handleSendInItalyChat({
    message: 'Confronta i primi due clienti per campagne e contatti',
    token: 'token',
    services,
  })
  const second = await handleSendInItalyChat({
    message: 'Ora escludi il primo e confronta i successivi due',
    token: 'token',
    history: [{role: 'assistant', data: first.data, meta: first.meta}],
    services,
  })

  assert.equal(second.intent, 'sendinitaly-user-analytics')
  assert.deepEqual(second.data.items.map(item => item.companyName), ['Beta', 'Gamma'])
  assert.equal(second.data.plan.filters.at(-1).value, 'Acme')
  assert.match(second.reply, /Beta[\s\S]*Gamma/)
})
