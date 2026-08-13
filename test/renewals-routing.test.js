import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {
  pickExplicitChatIntent,
  isLikelyBareRenewalsEntity,
} from '../src/modules/facile/renewals/intents.js'
import {
  assessServiceListQuery,
  buildServiceListPayload,
  parseServiceListQuery,
} from '../src/modules/facile/renewals/serviceQueries.js'
import {planServiceListRequest} from '../src/modules/facile/renewals/serviceQueryPlanner.js'
import {
  buildServiceListPagination,
  parseServiceListPaginationRequest,
} from '../src/modules/facile/renewals/serviceListPagination.js'
import {
  parseServiceListReferenceRequest,
  resolveServiceListReference,
} from '../src/modules/facile/renewals/serviceListReferences.js'
import {
  parsePleskAuditRequest,
  parseServiceHttpCheckRequest,
  parseServiceSubscriptionExpiryRequest,
} from '../src/modules/facile/renewals/diagnostics.js'
import {shouldResolveRenewalsIntentSemantically} from '../src/modules/facile/renewals/intentResolver.js'
import {
  buildCommunicationsContext,
  buildCommunicationsReply,
  extractNamedTarget,
} from '../src/modules/facile/renewals/communications.js'

const NOW = new Date(2026, 7, 4, 12, 0, 0)
const SETTINGS = {analysis_period: 30, renewals_low_thresholds: []}

function findFilter(query, kind) {
  return query.filters.find(filter => filter.kind === kind) || null
}

function assertDateParts(date, year, monthIndex, day) {
  assert.ok(date instanceof Date)
  assert.equal(date.getFullYear(), year)
  assert.equal(date.getMonth(), monthIndex)
  assert.equal(date.getDate(), day)
}

test('riconosce lo spazio esaurito anche con verbo prima del nome', () => {
  assert.equal(
    pickExplicitChatIntent("mostrami l'ultimo servizio che ha esaurito lo spazio"),
    'space-full'
  )

  const query = parseServiceListQuery({
    message: "mostrami l'ultimo servizio che ha esaurito lo spazio",
    settings: SETTINGS,
    now: NOW,
  })
  assert.equal(findFilter(query, 'space-full')?.kind, 'space-full')
})

function makeService({
  id,
  customerEnd,
  supplierEnd = null,
  dontRenew = false,
  customer = `Cliente ${id}`,
  group = 'Gruppo test',
  supplier = 'Register',
} = {}) {
  const supplierSubscriptions = supplierEnd
    ? [
        {
          id: `supplier-${id}`,
          isSupplier: true,
          startsOn: '2026-01-01T12:00:00',
          endsOn: supplierEnd,
          plan: {
            id: `supplier-plan-${id}`,
            name: `Piano fornitore ${id}`,
            supplier: {id: `supplier-ref-${id}`, name: supplier},
          },
          addons: [],
        },
      ]
    : []

  return {
    id,
    name: `${id}.it`,
    dontRenew,
    autoRenew: false,
    toRenew: false,
    customer: {
      id: `customer-${id}`,
      name: customer,
      group: {id: 'group-test', name: group},
    },
    domains_id: {id: `domain-${id}`, name: `${id}.it`},
    subscriptions: [
      {
        id: `customer-subscription-${id}`,
        isSupplier: false,
        startsOn: '2026-01-01T12:00:00',
        endsOn: customerEnd,
        plan: {
          id: `plan-${id}`,
          name: `Piano ${id}`,
          supplier: {id: 'webcloud', name: 'Webcloud'},
        },
        addons: [],
        suppliersSubscriptions: supplierSubscriptions,
      },
    ],
  }
}

const SERVICES = [
  makeService({
    id: 'scade-2027',
    customerEnd: '2027-05-01T12:00:00',
    supplierEnd: '2027-04-01T12:00:00',
  }),
  makeService({
    id: 'scade-2026',
    customerEnd: '2026-12-01T12:00:00',
    supplierEnd: '2028-04-01T12:00:00',
  }),
  makeService({
    id: 'fornitore-2027',
    customerEnd: '2028-05-01T12:00:00',
    supplierEnd: '2027-08-01T12:00:00',
  }),
  makeService({
    id: 'non-rinnovare-2027',
    customerEnd: '2027-09-01T12:00:00',
    dontRenew: true,
  }),
]

describe('Intenti espliciti e precedenze', () => {
  const listMessages = [
    'tutti i servizi che scadono nel 2027',
    'servizi in scadenza',
    'servizi in scadenza imminente',
    'servizi di zilio group',
    'servizi con piano DomProf170',
  ]

  for (const message of listMessages) {
    test(`riconosce come lista: ${message}`, () => {
      assert.equal(pickExplicitChatIntent(message), 'service-list')
    })
  }

  test('riconosce la scheda puntuale del servizio', () => {
    assert.equal(pickExplicitChatIntent('info su webcloud.it'), 'service-detail')
  })

  test('preserva tutti i vincoli di una lista composta', () => {
    const message =
      'Mostrami quali servizi di Zilio Group con scadenza entro il 2027 sono marchiati come non rinnovare e da trasferire contemporaneamente.'
    const plan = planServiceListRequest({message, settings: SETTINGS, now: NOW})

    assert.equal(pickExplicitChatIntent(message), 'service-list')
    assert.equal(plan?.intent, 'service-list')

    const filters = parseServiceListQuery({message, settings: SETTINGS, now: NOW}).filters
    assert.deepEqual(
      filters.map(filter => filter.kind),
      ['dont-renew', 'to-transfer', 'expires-in-range', 'customer-or-group']
    )
    assert.equal(findFilter({filters}, 'customer-or-group')?.term, 'Zilio Group')
  })

  test('un dominio isolato resta una possibile entità rinnovi', () => {
    assert.equal(isLikelyBareRenewalsEntity('eco-pv.it'), true)
  })

  test('una frase operativa non diventa una entità isolata', () => {
    assert.equal(isLikelyBareRenewalsEntity('scadono nel 2027'), false)
  })
})

describe('Parsing delle liste per data', () => {
  for (const year of [2026, 2027, 2028]) {
    test(`interpreta l'anno intero ${year}`, () => {
      const message = `tutti i servizi che scadono nel ${year}`
      const query = parseServiceListQuery({message, settings: SETTINGS, now: NOW})
      const range = findFilter(query, 'expires-in-range')

      assert.ok(range)
      assertDateParts(range.dateRange.start, year, 0, 1)
      assertDateParts(range.dateRange.end, year, 11, 31)
      assert.equal(findFilter(query, 'customer-or-group'), null)
      assert.deepEqual(assessServiceListQuery({message, query}), {
        valid: true,
        warnings: [],
      })
    })
  }

  test('mantiene cliente/gruppo e anno come filtri distinti', () => {
    const query = parseServiceListQuery({
      message: 'servizi del cliente Zilio Group con scadenza nel 2027',
      settings: SETTINGS,
      now: NOW,
    })

    assert.equal(findFilter(query, 'customer-or-group')?.term, 'Zilio Group')
    assert.ok(findFilter(query, 'expires-in-range'))
  })

  test('interpreta la scadenza fornitore senza aggiungere la scadenza cliente', () => {
    const query = parseServiceListQuery({
      message: 'servizi con scadenza fornitore nel 2027',
      settings: SETTINGS,
      now: NOW,
    })

    assert.ok(findFilter(query, 'supplier-expires-in-range'))
    assert.equal(findFilter(query, 'expires-in-range'), null)
    assert.equal(findFilter(query, 'customer-or-group'), null)
  })

  test('mantiene nome fornitore e relativa scadenza', () => {
    const query = parseServiceListQuery({
      message: 'servizi del fornitore Register con scadenza nel 2027',
      settings: SETTINGS,
      now: NOW,
    })

    assert.equal(findFilter(query, 'supplier')?.term, 'Register')
    assert.ok(findFilter(query, 'supplier-expires-in-range'))
  })

  test('interpreta la scadenza generica come finestra imminente', () => {
    const query = parseServiceListQuery({
      message: 'servizi in scadenza',
      settings: SETTINGS,
      now: NOW,
    })

    assert.ok(findFilter(query, 'expiring'))
    assert.equal(findFilter(query, 'customer-or-group'), null)
  })

  test('segnala una interpretazione sospetta prodotta artificialmente', () => {
    const assessment = assessServiceListQuery({
      message: 'tutti i servizi che scadono nel 2027',
      query: {
        filters: [
          {
            kind: 'customer-or-group',
            term: 'scadono nel 2027',
          },
        ],
      },
    })

    assert.equal(assessment.valid, false)
    assert.ok(
      assessment.warnings.includes('operational-text-interpreted-as-customer-or-group')
    )
    assert.ok(assessment.warnings.includes('explicit-year-without-expiry-range'))
  })
})

describe('Esecuzione dei filtri sulle liste', () => {
  test('filtra realmente i servizi con scadenza cliente nel 2027', () => {
    const payload = buildServiceListPayload({
      services: SERVICES,
      settings: SETTINGS,
      message: 'servizi che scadono nel 2027',
      now: NOW,
    })

    assert.equal(payload.totale, 1)
    assert.deepEqual(payload.items.map(item => item.servizio), ['scade-2027.it'])
    assert.equal(payload.query.excludedDontRenew, true)
  })

  test('la parola tutti include anche i NON RINNOVARE', () => {
    const payload = buildServiceListPayload({
      services: SERVICES,
      settings: SETTINGS,
      message: 'tutti i servizi che scadono nel 2027',
      now: NOW,
    })

    assert.equal(payload.totale, 2)
    assert.deepEqual(
      payload.items.map(item => item.servizio).sort(),
      ['non-rinnovare-2027.it', 'scade-2027.it']
    )
    assert.equal(payload.query.includeDontRenew, true)
  })

  test('la scadenza fornitore usa le sottoscrizioni fornitore', () => {
    const payload = buildServiceListPayload({
      services: SERVICES,
      settings: SETTINGS,
      message: 'servizi con scadenza fornitore nel 2027',
      now: NOW,
    })

    assert.deepEqual(
      payload.items.map(item => item.servizio).sort(),
      ['fornitore-2027.it', 'scade-2027.it']
    )
  })
})

describe('Planner delle liste', () => {
  test('crea una nuova lista per anno', () => {
    const plan = planServiceListRequest({
      message: 'tutti i servizi che scadono nel 2027',
      settings: SETTINGS,
      now: NOW,
    })

    assert.equal(plan?.intent, 'service-list')
    assert.equal(plan?.mode, 'new')
  })

  test('non intercetta una richiesta di dettaglio', () => {
    assert.equal(
      planServiceListRequest({message: 'info su webcloud.it', settings: SETTINGS, now: NOW}),
      null
    )
  })

  test('non intercetta una action sulla scadenza', () => {
    assert.equal(
      planServiceListRequest({
        message: 'imposta la scadenza cliente di eco-pv.it al 3 marzo 2028',
        settings: SETTINGS,
        now: NOW,
      }),
      null
    )
  })
})

describe('Paginazione e riferimenti alla lista', () => {
  const paginationCases = [
    ['mostramene altri 20', 'next', 20],
    ['prossimi', 'next', null],
    ['torna indietro', 'previous', null],
    ['torna ai primi 10', 'first', 10],
  ]

  for (const [message, direction, limit] of paginationCases) {
    test(`interpreta la paginazione: ${message}`, () => {
      assert.deepEqual(parseServiceListPaginationRequest(message), {direction, limit})
    })
  }

  test('calcola l’offset della pagina successiva', () => {
    const pagination = buildServiceListPagination(
      {
        offset: 20,
        shown: 20,
        limit: 20,
        nextOffset: 40,
        hasMore: true,
        sourceMessage: 'servizi di zilio group',
      },
      {direction: 'next', limit: 20}
    )

    assert.equal(pagination.offset, 40)
    assert.equal(pagination.limit, 20)
  })

  test('risolve il secondo elemento della lista', () => {
    const request = parseServiceListReferenceRequest('info sul secondo')
    const resolved = resolveServiceListReference({
      request,
      items: [
        {servizio: 'primo.it'},
        {servizio: 'secondo.it'},
      ],
    })

    assert.equal(resolved.status, 'resolved')
    assert.equal(resolved.item.servizio, 'secondo.it')
  })

  test('risolve un riferimento testuale al fornitore', () => {
    const request = parseServiceListReferenceRequest('info su quello con fornitore Webcloud')
    const resolved = resolveServiceListReference({
      request,
      items: [
        {servizio: 'uno.it', fornitori: ['Register']},
        {servizio: 'due.it', fornitori: ['Webcloud']},
      ],
    })

    assert.equal(resolved.status, 'resolved')
    assert.equal(resolved.item.servizio, 'due.it')
  })
})

describe('Diagnostiche e separazione lista/singolo servizio', () => {
  test('legge la scadenza cliente di un servizio puntuale', () => {
    const request = parseServiceSubscriptionExpiryRequest(
      'qual è la scadenza cliente di eco-pv.it?'
    )

    assert.equal(request?.subscriptionKind, 'customer')
    assert.equal(request?.namedTarget, 'eco-pv.it')
  })

  test('legge la scadenza generica di un servizio puntuale', () => {
    const request = parseServiceSubscriptionExpiryRequest('quando scade eco-pv.it?')

    assert.equal(request?.subscriptionKind, 'all')
    assert.equal(request?.namedTarget, 'eco-pv.it')
  })

  test('non sottrae al planner una richiesta plurale per anno', () => {
    assert.equal(
      parseServiceSubscriptionExpiryRequest('tutti i servizi che scadono nel 2027'),
      null
    )
  })

  test('non sottrae al planner una richiesta generica di lista', () => {
    assert.equal(parseServiceSubscriptionExpiryRequest('servizi in scadenza'), null)
  })

  test('riconosce il controllo HTTP puntuale', () => {
    const request = parseServiceHttpCheckRequest('controlla se eco-pv.it risponde')

    assert.equal(request?.namedTarget, 'eco-pv.it')
    assert.equal(request?.protocol, 'auto')
  })

  test('riconosce l’audit Plesk globale', () => {
    const request = parsePleskAuditRequest('esegui un audit Plesk')

    assert.equal(request?.selectorSource, 'all')
    assert.deepEqual(request?.filters.codes, [])
  })

  test('riconosce il filtro Plesk non sincronizzato', () => {
    const request = parsePleskAuditRequest('mostra le subscription Plesk non sincronizzate')

    assert.deepEqual(request?.filters.codes, ['plesk_subscription_not_synced'])
  })
})

describe('Fallback semantico Ollama', () => {
  test('non viene invocato quando la lista deterministica è valida', () => {
    assert.equal(
      shouldResolveRenewalsIntentSemantically({
        message: 'tutti i servizi che scadono nel 2027',
        explicitIntent: 'service-list',
        serviceListQueryAssessment: {valid: true, warnings: []},
        serviceListPlan: {intent: 'service-list'},
        plan: {type: 'tool'},
      }),
      false
    )
  })

  test('viene invocato quando una lista deterministica è sospetta', () => {
    assert.equal(
      shouldResolveRenewalsIntentSemantically({
        message: 'tutti i servizi che scadono nel 2027',
        explicitIntent: 'service-list',
        serviceListQueryAssessment: {
          valid: false,
          warnings: ['explicit-year-without-expiry-range'],
        },
        serviceListPlan: {intent: 'service-list'},
        plan: {type: 'tool'},
      }),
      true
    )
  })

  test('non viene invocato per una risposta diretta del core', () => {
    assert.equal(
      shouldResolveRenewalsIntentSemantically({
        message: 'servizi in scadenza',
        explicitIntent: null,
        plan: {type: 'direct'},
      }),
      false
    )
  })
})

describe('Comunicazioni deterministiche', () => {
  const servicesWithCommunications = [
    {
      id: 'service-eco-pv',
      name: 'eco-pv.it',
      customer: {
        id: 'customer-eco-pv',
        name: 'Consorzio Eco-Pv',
        group: {id: 'group-zilio', name: 'Zilio Group Srl'},
      },
      renewalsCommunications: [
        {
          id: 'communication-old',
          type: '1',
          typeLabel: 'Inviato richiesta rinnovo',
          communicationDate: '2026-05-10T08:30:00.000Z',
        },
        {
          id: 'communication-latest',
          type: '2',
          typeLabel: 'Inviato richiesta upgrade',
          communicationDate: '2026-06-11T18:51:00.000Z',
        },
      ],
    },
  ]

  test('estrae il dominio senza lasciare "qual è" nel target', () => {
    assert.equal(
      extractNamedTarget("qual è l'ultima email inviata per eco-pv.it?"),
      'eco-pv.it'
    )
  })

  test('estrae cliente e gruppo dopo la preposizione', () => {
    assert.equal(
      extractNamedTarget("qual è l'ultima email inviata per Consorzio Eco-Pv?"),
      'Consorzio Eco-Pv'
    )
    assert.equal(
      extractNamedTarget('ultima comunicazione inviata per Zilio Group Srl'),
      'Zilio Group Srl'
    )
  })

  test('costruisce la risposta puntuale senza usare Ollama', () => {
    const payload = {
      type: 'communications',
      ...buildCommunicationsContext({
        services: servicesWithCommunications,
        message: "qual è l'ultima email inviata per eco-pv.it?",
      }),
    }

    const reply = buildCommunicationsReply(payload, {
      message: "qual è l'ultima email inviata per eco-pv.it?",
    })

    assert.equal(payload.totalCommunications, 2)
    assert.equal(payload.latestCommunication.typeLabel, 'Inviato richiesta upgrade')
    assert.match(reply, /L’ultima comunicazione inviata/i)
    assert.match(reply, /Inviato richiesta upgrade/i)
    assert.match(reply, /eco-pv\.it/i)
  })

  test('mantiene la lista per una richiesta plurale', () => {
    const payload = {
      type: 'communications',
      ...buildCommunicationsContext({
        services: servicesWithCommunications,
        message: 'quali sono le ultime email inviate?',
      }),
    }

    const reply = buildCommunicationsReply(payload, {
      message: 'quali sono le ultime email inviate?',
    })

    assert.match(reply, /Ho trovato 2 comunicazioni inviate/i)
    assert.match(reply, /Inviato richiesta upgrade/i)
    assert.match(reply, /Inviato richiesta rinnovo/i)
  })
})
