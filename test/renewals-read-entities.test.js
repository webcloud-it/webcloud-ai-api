import test from 'node:test'
import assert from 'node:assert/strict'

import {planReadQuery, getPreviousReadQueryState} from '../src/modules/facile/renewals/readQueryPlanner.js'
import {executeReadQuery} from '../src/modules/facile/renewals/readQueryExecutor.js'
import {buildReadQueryReply} from '../src/modules/facile/renewals/readQueryFormatters.js'
import {
  canExecuteReadQueryFromCatalog,
  getReadEntityRegistry,
} from '../src/modules/facile/renewals/readEntityRegistry.js'
import {validateReadQueryPlan} from '../src/modules/facile/renewals/readQueryContract.js'
import {
  clearAllReadQueryContexts,
  rememberReadQueryContext,
} from '../src/modules/facile/renewals/readQueryContext.js'
import {
  resolveReadQueryDetailTarget,
  shouldResolveReadQueryDetailTarget,
} from '../src/modules/facile/renewals/readQueryTargetResolver.js'
import {
  clearAllPendingReadQueryTargetClarifications,
  rememberReadQueryTargetClarification,
  resolvePendingReadQueryTargetClarification,
} from '../src/modules/facile/renewals/readQueryClarifications.js'
import {
  interpretReadQueryUtterance,
  parseReadQueryUtterance,
} from '../src/modules/facile/renewals/readQueryUtterance.js'

const services = [
  {
    id: 'svc-1',
    name: 'eco-pv.it',
    customer: {
      id: 'cust-1',
      name: 'Consorzio Eco-Pv',
      group: {id: 'group-1', name: 'Zilio Group Srl'},
      priceListVersionRef: {id: 'price-1', name: 'Listino standard'},
    },
    domains_id: {id: 'domain-1', name: 'eco-pv.it'},
    pleskDomain: {id: 'plesk-1', integration_id: 'guid-1'},
    servicesTypes: [
      {id: 'type-1', name: 'Hosting', macro: {id: 'macro-1', name: 'Web'}},
    ],
    renewalsCommunications: [
      {
        id: 'comm-1',
        type: '1',
        typeLabel: 'Preavviso rinnovo',
        communicationDate: '2026-07-01T12:00:00.000Z',
      },
    ],
    subscriptions: [
      {
        id: 'sub-c-1',
        isSupplier: false,
        startsOn: '2026-02-13T12:00:00.000Z',
        endsOn: '2027-02-13T12:00:00.000Z',
        plan: {
          id: 'plan-c-1',
          name: 'DomProf170 NoSSL',
          duration: 12,
          supplier: {id: 'provider-webcloud', name: 'WebCloud'},
          resources: [{id: 'resource-disk', name: 'Spazio su disco', amount: 170}],
          servicesTypesOut: [
            {id: 'type-1', name: 'Hosting', macro: {id: 'macro-1', name: 'Web'}},
          ],
          priceFinal: 300,
          priceList: 300,
          priceListStandard: 300,
        },
        addons: [
          {
            id: 'addon-1',
            addonId: 'plan-addon-1',
            name: 'Backup 100 GB',
            resources: [{id: 'resource-backup', name: 'Spazio backup', amount: 100}],
            priceFinal: 50,
            priceList: 50,
            priceListStandard: 50,
          },
        ],
        suppliersSubscriptions: [
          {
            id: 'sub-s-1',
            isSupplier: true,
            startsOn: '2026-02-15T12:00:00.000Z',
            endsOn: '2027-02-15T12:00:00.000Z',
            plan: {
              id: 'plan-s-1',
              name: 'MisterDomainDom-it',
              duration: 12,
              supplier: {id: 'provider-mister', name: 'MisterDomain'},
              resources: [],
              priceFinal: null,
              missingPrice: true,
            },
            addons: [],
          },
        ],
      },
    ],
  },
  {
    id: 'svc-2',
    name: 'example.it',
    customer: {
      id: 'cust-2',
      name: 'Cliente Example',
      group: null,
    },
    domains_id: {id: 'domain-2', name: 'example.it'},
    pleskDomain: null,
    servicesTypes: [{id: 'type-2', name: 'Dominio', macro: {id: 'macro-1', name: 'Web'}}],
    renewalsCommunications: [],
    subscriptions: [
      {
        id: 'sub-c-2',
        isSupplier: false,
        startsOn: '2027-06-01T12:00:00.000Z',
        endsOn: '2028-06-01T12:00:00.000Z',
        plan: {
          id: 'plan-c-2',
          name: 'DomProf5',
          duration: 12,
          supplier: {id: 'provider-webcloud', name: 'WebCloud'},
          resources: [{id: 'resource-disk', name: 'Spazio su disco', amount: 5}],
          servicesTypesOut: [{id: 'type-2', name: 'Dominio'}],
          priceFinal: 120,
          priceList: 120,
          priceListStandard: 120,
        },
        addons: [],
        suppliersSubscriptions: [],
      },
    ],
  },
]

const options = {
  providers: [
    {value: 'provider-webcloud', label: 'WebCloud'},
    {value: 'provider-mister', label: 'MisterDomain'},
    {value: 'provider-unused', label: 'Fornitore non utilizzato'},
  ],
  customers: [
    {value: 'cust-1', label: 'Consorzio Eco-Pv'},
    {value: 'cust-2', label: 'Cliente Example'},
  ],
  groups: [{value: 'group-1', label: 'Zilio Group Srl'}],
  serviceTypes: [
    {value: 'type-1', label: 'Hosting'},
    {value: 'type-2', label: 'Dominio'},
  ],
}

test('registro entità: espone fornitori, piani, risorse e tipi', () => {
  const registry = getReadEntityRegistry()
  for (const entity of [
    'providers',
    'plans',
    'addons',
    'resources',
    'service-types',
    'macro-service-types',
    'customers',
    'groups',
    'subscriptions',
    'domains',
    'communications',
    'price-lists',
    'plan-prices',
  ]) {
    assert.equal(registry.has(entity), true, entity)
  }
})

test('planner: tutti i fornitori non diventa un filtro servizi', async () => {
  const plan = await planReadQuery({message: 'tutti i fornitori', allowSemantic: false})
  assert.equal(plan.entity, 'providers')
  assert.equal(plan.operation, 'list')
  assert.deepEqual(plan.filters, [])
})

test('planner: lista dei fornitori presenti', async () => {
  const plan = await planReadQuery({
    message: 'lista dei fornitori presenti',
    allowSemantic: false,
  })
  assert.equal(plan.entity, 'providers')
  assert.deepEqual(plan.filters, [
    {field: 'present', operator: 'truthy', value: null},
  ])
})

test('planner: quanti fornitori abbiamo', async () => {
  const plan = await planReadQuery({message: 'quanti fornitori abbiamo?', allowSemantic: false})
  assert.equal(plan.entity, 'providers')
  assert.equal(plan.operation, 'count')
})

test('planner: piani del fornitore MisterDomain', async () => {
  const plan = await planReadQuery({
    message: 'mostrami i piani del fornitore MisterDomain',
    allowSemantic: false,
  })
  assert.equal(plan.entity, 'plans')
  assert.deepEqual(plan.filters, [
    {field: 'supplier.name', operator: 'contains', value: 'misterdomain'},
  ])
})

test('planner: risorse del piano DomProf170', async () => {
  const plan = await planReadQuery({
    message: 'quali risorse contiene il piano DomProf170 NoSSL?',
    allowSemantic: false,
  })
  assert.equal(plan.entity, 'resources')
  assert.deepEqual(plan.filters, [
    {field: 'planNames', operator: 'contains', value: 'domprof170 nossl'},
  ])
})

test('planner: clienti del gruppo Zilio', async () => {
  const plan = await planReadQuery({
    message: 'clienti del gruppo Zilio',
    allowSemantic: false,
  })
  assert.equal(plan.entity, 'customers')
  assert.deepEqual(plan.filters, [
    {field: 'group.name', operator: 'contains', value: 'zilio'},
  ])
})

test('planner ed executor: clienti con servizi in scadenza in un mese preciso', async () => {
  const monthlyServices = [
    {
      id: 'svc-september',
      name: 'settembre.it',
      customer: {id: 'cust-september', name: 'Cliente Settembre'},
      subscriptions: [
        {
          id: 'sub-september',
          isSupplier: false,
          endsOn: '2026-09-14T12:00:00.000Z',
          plan: {id: 'plan-september', name: 'Piano settembre'},
        },
      ],
    },
    {
      id: 'svc-october',
      name: 'ottobre.it',
      customer: {id: 'cust-october', name: 'Cliente Ottobre'},
      subscriptions: [
        {
          id: 'sub-october',
          isSupplier: false,
          endsOn: '2026-10-02T12:00:00.000Z',
          plan: {id: 'plan-october', name: 'Piano ottobre'},
        },
      ],
    },
  ]
  const message = 'quali sono i clienti con servizi in scadenza a settembre 2026'
  const plan = await planReadQuery({message, allowSemantic: false})

  assert.equal(plan.entity, 'customers')
  assert.deepEqual(plan.filters, [
    {
      field: 'expiryDates',
      operator: 'between',
      value: {
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-09-30T23:59:59.999Z',
      },
    },
  ])

  const result = executeReadQuery({plan, services: monthlyServices, options: {}})
  assert.equal(result.total, 1)
  assert.equal(result.items[0].name, 'Cliente Settembre')
})

test('planner: sottoscrizioni del fornitore MisterDomain nel 2027', async () => {
  const plan = await planReadQuery({
    message: 'sottoscrizioni del fornitore MisterDomain che scadono nel 2027',
    allowSemantic: false,
  })
  assert.equal(plan.entity, 'subscriptions')
  assert.equal(plan.filters.some(filter => filter.field === 'kind' && filter.value === 'supplier'), true)
  assert.equal(plan.filters.some(filter => filter.field === 'supplier.name' && filter.value === 'misterdomain'), true)
  assert.equal(plan.filters.some(filter => filter.field === 'endsOn' && filter.operator === 'between'), true)
})

test('planner: le liste servizi restano delegate al sistema storico', async () => {
  const plan = await planReadQuery({
    message: 'servizi del fornitore MisterDomain',
    allowSemantic: false,
  })
  assert.equal(plan, null)
})

test('executor: elenca soltanto i fornitori realmente presenti', async () => {
  const plan = await planReadQuery({
    message: 'lista dei fornitori presenti',
    allowSemantic: false,
  })
  const result = executeReadQuery({plan, services, options})
  assert.equal(result.ok, true)
  assert.equal(result.total, 2)
  assert.deepEqual(result.items.map(item => item.name), ['MisterDomain', 'WebCloud'])
})

test('executor: filtra i piani per fornitore', async () => {
  const plan = await planReadQuery({
    message: 'piani del fornitore MisterDomain',
    allowSemantic: false,
  })
  const result = executeReadQuery({plan, services, options})
  assert.equal(result.total, 1)
  assert.equal(result.items[0].name, 'MisterDomainDom-it')
})

test('executor: recupera le risorse di uno specifico piano', async () => {
  const plan = await planReadQuery({
    message: 'risorse del piano DomProf170 NoSSL',
    allowSemantic: false,
  })
  const result = executeReadQuery({plan, services, options})
  assert.equal(result.total, 1)
  assert.equal(result.items[0].name, 'Spazio su disco')
  const usage = result.items[0].planUsages.find(item => item.planName === 'DomProf170 NoSSL')
  assert.deepEqual(usage.amounts, [170])
  assert.match(buildReadQueryReply(result), /valori: 170/i)
})

test('executor: conta i fornitori senza mostrare righe', async () => {
  const plan = await planReadQuery({message: 'quanti fornitori abbiamo?', allowSemantic: false})
  const result = executeReadQuery({plan, services, options})
  assert.equal(result.operation, 'count')
  assert.equal(result.total, 3)
  assert.equal(result.items.length, 0)
})

test('formatter: produce una risposta leggibile', async () => {
  const plan = await planReadQuery({message: 'tutti i fornitori', allowSemantic: false})
  const result = executeReadQuery({plan, services, options})
  const reply = buildReadQueryReply(result)
  assert.match(reply, /Ho trovato 3 fornitori/i)
  assert.match(reply, /MisterDomain/i)
  assert.match(reply, /WebCloud/i)
})

test('stato: recupera il piano strutturato dalla cronologia', () => {
  const history = [
    {role: 'user', content: 'tutti i fornitori'},
    {
      role: 'assistant',
      content: 'Ho trovato 3 fornitori.',
      data: {
        type: 'read-query-result',
        entity: 'providers',
        total: 3,
        shown: 2,
        offset: 0,
        limit: 2,
        hasMore: true,
        nextOffset: 2,
        plan: {
          type: 'read-query-plan',
          operation: 'list',
          entity: 'providers',
          filters: [],
          sort: [{field: 'name', direction: 'asc'}],
          limit: 2,
          offset: 0,
        },
      },
    },
  ]

  const state = getPreviousReadQueryState(history)
  assert.equal(state.entity, 'providers')
  assert.equal(state.nextOffset, 2)
})

test('follow-up: altri usa il piano precedente e aggiorna offset', async () => {
  const history = [
    {
      role: 'assistant',
      content: 'Ho trovato 3 fornitori.',
      data: {
        type: 'read-query-result',
        entity: 'providers',
        total: 3,
        shown: 2,
        offset: 0,
        limit: 2,
        hasMore: true,
        nextOffset: 2,
        previousOffset: 0,
        plan: {
          type: 'read-query-plan',
          operation: 'list',
          entity: 'providers',
          filters: [],
          sort: [{field: 'name', direction: 'asc'}],
          limit: 2,
          offset: 0,
        },
      },
    },
  ]

  const plan = await planReadQuery({message: 'altri', history, allowSemantic: false})
  assert.equal(plan.entity, 'providers')
  assert.equal(plan.offset, 2)
  assert.equal(plan.limit, 2)
})

test('semantic planner: valida un piano JSON e conserva il previousPlan', async () => {
  const history = [
    {
      role: 'assistant',
      data: {
        type: 'read-query-result',
        entity: 'providers',
        total: 3,
        shown: 3,
        offset: 0,
        limit: 20,
        hasMore: false,
        plan: {
          type: 'read-query-plan',
          operation: 'list',
          entity: 'providers',
          filters: [],
          sort: [{field: 'name', direction: 'asc'}],
          limit: 20,
          offset: 0,
        },
      },
    },
  ]

  const plan = await planReadQuery({
    message: 'solo quelli con servizi in scadenza nel 2027',
    history,
    callLlm: async () =>
      JSON.stringify({
        operation: 'list',
        entity: 'providers',
        filters: [{field: 'expiryYears', operator: 'contains', value: 2027}],
        sort: [{field: 'name', direction: 'asc'}],
        limit: 20,
        offset: 0,
        confidence: 0.99,
      }),
  })

  assert.equal(plan.entity, 'providers')
  assert.deepEqual(plan.filters, [
    {field: 'expiryYears', operator: 'contains', value: 2027},
  ])
})

test('contratto: rifiuta campi non registrati', () => {
  const validation = validateReadQueryPlan(
    {
      operation: 'list',
      entity: 'providers',
      filters: [{field: 'database_password', operator: 'contains', value: 'x'}],
    },
    getReadEntityRegistry()
  )
  assert.equal(validation.ok, true)
  assert.deepEqual(validation.plan.filters, [])
})


test('planner: gli add-on usano il catalogo completo', async () => {
  const plan = await planReadQuery({
    message: 'tutti gli add-on di WebCloud',
    allowSemantic: false,
  })

  assert.equal(plan.entity, 'addons')
  assert.deepEqual(plan.filters, [
    {field: 'supplier.name', operator: 'contains', value: 'webcloud'},
  ])
  assert.equal(canExecuteReadQueryFromCatalog(plan), true)
})

test('planner: prezzo di un piano in una versione del listino', async () => {
  const plan = await planReadQuery({
    message: 'quanto costa il piano DomProf170 NoSSL nel listino 2026',
    allowSemantic: false,
  })

  assert.equal(plan.entity, 'plan-prices')
  assert.equal(plan.operation, 'detail')
  assert.deepEqual(plan.filters, [
    {field: 'plan.name', operator: 'contains', value: 'domprof170 nossl'},
    {field: 'priceListVersion.version', operator: 'equals', value: 2026},
  ])
  assert.equal(canExecuteReadQueryFromCatalog(plan), true)
})

test('planner: prezzi degli add-on nel listino', async () => {
  const plan = await planReadQuery({
    message: 'prezzi degli add-on nel listino 2026',
    allowSemantic: false,
  })

  assert.equal(plan.entity, 'plan-prices')
  assert.deepEqual(plan.filters, [
    {field: 'priceListVersion.version', operator: 'equals', value: 2026},
    {field: 'plan.kind', operator: 'equals', value: 'addon'},
  ])
})

test('executor: arricchisce un prezzo di catalogo con l’uso operativo del piano', () => {
  const plan = {
    operation: 'list',
    entity: 'plan-prices',
    filters: [],
    sort: [{field: 'plan.name', direction: 'asc'}],
    limit: 20,
    offset: 0,
  }

  const result = executeReadQuery({
    plan,
    services,
    options,
    catalogResult: {
      ok: true,
      source: 'catalog',
      sourceScope: 'complete-master-data',
      catalogVersion: 'renewals-v2',
      entity: 'plan-prices',
      operation: 'list',
      total: 1,
      shown: 1,
      offset: 0,
      limit: 20,
      nextOffset: 1,
      previousOffset: 0,
      hasMore: false,
      items: [
        {
          id: 'price-catalog-1',
          name: 'DomProf170 NoSSL · Listino standard',
          price: 300,
          plan: {id: 'plan-c-1', name: 'DomProf170 NoSSL', kind: 'base'},
          supplier: {id: 'provider-webcloud', name: 'WebCloud'},
          priceListVersion: {id: 'price-1', name: 'Listino standard', version: 2026},
        },
      ],
    },
  })

  assert.equal(result.dataSource, 'catalog')
  assert.equal(result.items[0].usage.status, 'used')
  assert.equal(result.items[0].serviceCount, 1)
  assert.match(buildReadQueryReply(result), /300,00/i)
})

test('planner: dettaglio esplicito di un add-on applica il filtro sul nome', async () => {
  const plan = await planReadQuery({
    message: 'dettagli dell’add-on SendInItalyIPDed',
    allowSemantic: false,
  })

  assert.equal(plan.entity, 'addons')
  assert.equal(plan.operation, 'detail')
  assert.deepEqual(plan.filters, [
    {field: 'name', operator: 'contains', value: 'SendInItalyIPDed'},
  ])
})

test('planner: dettaglio senza entità usa l’ultima entità del catalogo', async () => {
  const history = [
    {
      role: 'assistant',
      content: 'Non ho trovato add-on.',
      data: {
        type: 'read-query-result',
        entity: 'addons',
        total: 0,
        shown: 0,
        offset: 0,
        limit: 20,
        hasMore: false,
        items: [],
        plan: {
          type: 'read-query-plan',
          operation: 'list',
          entity: 'addons',
          filters: [{field: 'supplier.name', operator: 'contains', value: 'MisterDomain'}],
          sort: [{field: 'name', direction: 'asc'}],
          limit: 20,
          offset: 0,
        },
      },
    },
  ]

  const plan = await planReadQuery({
    message: 'dettagli SendInItalyIPDed',
    history,
    allowSemantic: false,
  })

  assert.equal(plan.entity, 'addons')
  assert.equal(plan.operation, 'detail')
  assert.deepEqual(plan.filters, [
    {field: 'name', operator: 'contains', value: 'SendInItalyIPDed'},
  ])
})

test('planner: dettaglio del secondo usa l’id della riga mostrata', async () => {
  const history = [
    {
      role: 'assistant',
      content: 'Ho trovato due add-on.',
      data: {
        type: 'read-query-result',
        entity: 'addons',
        total: 2,
        shown: 2,
        offset: 0,
        limit: 20,
        hasMore: false,
        items: [
          {id: 'addon-first', name: 'Primo add-on'},
          {id: 'addon-second', name: 'Secondo add-on'},
        ],
        plan: {
          type: 'read-query-plan',
          operation: 'list',
          entity: 'addons',
          filters: [],
          sort: [{field: 'name', direction: 'asc'}],
          limit: 20,
          offset: 0,
        },
      },
    },
  ]

  const plan = await planReadQuery({
    message: 'dettagli del secondo',
    history,
    allowSemantic: false,
  })

  assert.equal(plan.entity, 'addons')
  assert.equal(plan.operation, 'detail')
  assert.deepEqual(plan.filters, [
    {field: 'id', operator: 'equals', value: 'addon-second'},
  ])
  assert.equal(plan.limit, 1)
})

test('formatter: il dettaglio unico non viene presentato come lista generica', () => {
  const reply = buildReadQueryReply({
    ok: true,
    type: 'read-query-result',
    entity: 'addons',
    entityLabel: 'add-on',
    entitySingular: 'add-on',
    operation: 'detail',
    dataSource: 'catalog',
    total: 1,
    shown: 1,
    offset: 0,
    limit: 10,
    hasMore: false,
    items: [
      {
        id: 'addon-send-in-italy-ip-ded',
        name: 'SendInItalyIPDed',
        supplier: {name: 'Webcloud'},
        serviceCount: 1,
        resourceNames: ['IP dedicati inclusi'],
        prices: [228],
        usage: {status: 'used'},
      },
    ],
  })

  assert.match(reply, /Dettagli dell[’']add-on SendInItalyIPDed nel catalogo completo/i)
  assert.match(reply, /fornitore Webcloud/i)
  assert.doesNotMatch(reply, /Ho trovato 1 add-on/i)
})


test('planner: ricostruisce il contesto entità anche da cronologia solo testuale', async () => {
  const history = [
    {role: 'user', content: 'dettagli dell’add-on SendInItalyIPDed'},
    {
      role: 'assistant',
      content:
        'Dettagli dell’add-on SendInItalyIPDed nel catalogo completo:\n\n' +
        'SendInItalyIPDed | fornitore Webcloud | 1 servizio | utilizzato nei servizi',
    },
  ]

  const plan = await planReadQuery({
    message: 'dettagli di SendInItalyIPDed',
    history,
    allowSemantic: false,
  })

  assert.equal(plan.entity, 'addons')
  assert.equal(plan.operation, 'detail')
  assert.deepEqual(plan.filters, [
    {field: 'name', operator: 'contains', value: 'SendInItalyIPDed'},
  ])
})

test('planner: ricostruisce il riferimento ordinale da una risposta testuale', async () => {
  const history = [
    {role: 'user', content: 'mostrami i primi 2 add-on'},
    {
      role: 'assistant',
      content:
        'Ho trovato 38 add-on nel catalogo completo. Ti mostro i risultati 1-2.\n\n' +
        '- Primo add-on | fornitore Webcloud\n' +
        '- Secondo add-on | fornitore Webcloud\n\n' +
        'Puoi chiedermi "altri 2" per continuare.',
    },
  ]

  const plan = await planReadQuery({
    message: 'dettagli del secondo',
    history,
    allowSemantic: false,
  })

  assert.equal(plan.entity, 'addons')
  assert.deepEqual(plan.filters, [
    {field: 'name', operator: 'equals', value: 'Secondo add-on'},
  ])
  assert.equal(plan.limit, 1)
})

test('planner: usa il contesto server-side quando la cronologia non conserva i dati', async () => {
  clearAllReadQueryContexts()
  const actorToken = 'read-context-addons'
  const previousPlan = {
    type: 'read-query-plan',
    operation: 'detail',
    entity: 'addons',
    filters: [{field: 'name', operator: 'contains', value: 'SendInItalyIPDed'}],
    sort: [{field: 'name', direction: 'asc'}],
    limit: 10,
    offset: 0,
  }

  rememberReadQueryContext({
    actorToken,
    plan: previousPlan,
    result: {
      ok: true,
      type: 'read-query-result',
      entity: 'addons',
      operation: 'detail',
      total: 1,
      shown: 1,
      offset: 0,
      limit: 10,
      hasMore: false,
      items: [{id: 'addon-send', name: 'SendInItalyIPDed'}],
      dataSource: 'catalog',
    },
  })

  const plan = await planReadQuery({
    message: 'dettagli di SendInItalyIPDed',
    history: [],
    actorToken,
    allowSemantic: false,
  })

  assert.equal(plan.entity, 'addons')
  assert.deepEqual(plan.filters, [
    {field: 'name', operator: 'contains', value: 'SendInItalyIPDed'},
  ])
})

test('planner: un nuovo argomento servizi non eredita il vecchio contesto catalogo', async () => {
  clearAllReadQueryContexts()
  const actorToken = 'read-context-reset-services'

  rememberReadQueryContext({
    actorToken,
    plan: {
      type: 'read-query-plan',
      operation: 'list',
      entity: 'addons',
      filters: [],
      sort: [{field: 'name', direction: 'asc'}],
      limit: 20,
      offset: 0,
    },
    result: {
      ok: true,
      type: 'read-query-result',
      entity: 'addons',
      operation: 'list',
      total: 1,
      shown: 1,
      offset: 0,
      limit: 20,
      hasMore: false,
      items: [{id: 'addon-send', name: 'SendInItalyIPDed'}],
    },
  })

  const plan = await planReadQuery({
    message: 'dettagli di eco-pv.it',
    history: [
      {role: 'user', content: 'servizi di Zilio Group'},
      {role: 'assistant', content: 'Ho trovato 82 servizi.'},
    ],
    actorToken,
    allowSemantic: false,
  })

  assert.equal(plan, null)
})


test('resolver dettaglio: riconosce un piano anche se il contesto precedente era add-on', async () => {
  const resolution = await resolveReadQueryDetailTarget({
    message: 'dettagli di DomProf170 NoSSL',
    services,
    options,
  })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.entityId, 'plans')
  assert.equal(resolution.filter.field, 'id')
  assert.equal(resolution.filter.value, 'plan-c-1')
})

test('resolver dettaglio: riconosce un add-on senza dipendere dal contesto', async () => {
  const resolution = await resolveReadQueryDetailTarget({
    message: "dettagli dell'add-on Backup 100 GB",
    services,
    options,
  })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.entityId, 'addons')
  assert.equal(resolution.filter.value, 'plan-addon-1')
})

test('resolver dettaglio: riconosce un servizio dal dominio e lo preferisce al record dominio', async () => {
  const resolution = await resolveReadQueryDetailTarget({
    message: 'dettagli di eco-pv.it',
    services,
    options,
  })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.entityId, 'services')
})

test('resolver dettaglio: usa il catalogo per una anagrafica non presente nei servizi', async () => {
  const resolution = await resolveReadQueryDetailTarget({
    message: 'dettagli di Piano mai utilizzato',
    services,
    options,
    queryCatalog: async plan => {
      if (plan.entity !== 'plans') {
        return {ok: true, items: []}
      }

      return {
        ok: true,
        items: [{id: 'unused-plan', name: 'Piano mai utilizzato'}],
      }
    },
  })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.entityId, 'plans')
  assert.equal(resolution.source, 'catalog')
  assert.equal(resolution.filter.value, 'unused-plan')
})

test('resolver dettaglio: chiede chiarimento quando lo stesso nome appartiene a più entità', async () => {
  const ambiguousOptions = {
    ...options,
    providers: [...options.providers, {value: 'provider-shared', label: 'Webcloud Shared'}],
    customers: [...options.customers, {value: 'customer-shared', label: 'Webcloud Shared'}],
  }
  const resolution = await resolveReadQueryDetailTarget({
    message: 'dettagli di Webcloud Shared',
    services,
    options: ambiguousOptions,
  })

  assert.equal(resolution.status, 'ambiguous')
  assert.equal(
    resolution.candidates.some(candidate => candidate.entityId === 'providers'),
    true
  )
  assert.equal(
    resolution.candidates.some(candidate => candidate.entityId === 'customers'),
    true
  )
})

test('resolver dettaglio: non intercetta riferimenti ordinali o puramente contestuali', () => {
  assert.equal(shouldResolveReadQueryDetailTarget('dettagli del secondo'), false)
  assert.equal(shouldResolveReadQueryDetailTarget('dettagli di questo'), false)
  assert.equal(shouldResolveReadQueryDetailTarget('dettagli di DomProf170 NoSSL'), true)
})

test('planner: una risoluzione esplicita del target sostituisce il vecchio contesto entità', async () => {
  clearAllReadQueryContexts()
  const actorToken = 'target-resolution-overrides-context'

  rememberReadQueryContext({
    actorToken,
    plan: {
      type: 'read-query-plan',
      operation: 'detail',
      entity: 'addons',
      filters: [{field: 'name', operator: 'contains', value: 'Backup 100 GB'}],
      sort: [{field: 'name', direction: 'asc'}],
      limit: 10,
      offset: 0,
    },
    result: {
      ok: true,
      type: 'read-query-result',
      entity: 'addons',
      operation: 'detail',
      total: 1,
      shown: 1,
      items: [{id: 'plan-addon-1', name: 'Backup 100 GB'}],
    },
  })

  const plan = await planReadQuery({
    message: 'dettagli di DomProf170 NoSSL',
    actorToken,
    allowSemantic: false,
    resolvedDetailTarget: {
      entityId: 'plans',
      filter: {field: 'id', operator: 'equals', value: 'plan-c-1'},
    },
  })

  assert.equal(plan.entity, 'plans')
  assert.deepEqual(plan.filters, [
    {field: 'id', operator: 'equals', value: 'plan-c-1'},
  ])
  assert.equal(plan.source, 'deterministic-target-resolution')
})


test('formatter: il dettaglio del piano dichiara esplicitamente il tipo di entità', () => {
  const reply = buildReadQueryReply({
    ok: true,
    type: 'read-query-result',
    entity: 'plans',
    entityLabel: 'piani',
    entitySingular: 'piano',
    operation: 'detail',
    dataSource: 'catalog',
    total: 1,
    shown: 1,
    offset: 0,
    limit: 10,
    hasMore: false,
    items: [
      {
        id: 'plan-domprof10',
        name: 'DomProf10',
        supplier: {name: 'Webcloud'},
        duration: 12,
        serviceCount: 7,
        usage: {status: 'used'},
      },
    ],
  })

  assert.match(reply, /Dettagli del piano DomProf10 nel catalogo completo/i)
})

test('chiarimento entità: la risposta gruppo seleziona il gruppo ambiguo', () => {
  clearAllPendingReadQueryTargetClarifications()
  const actorToken = 'clarification-group'

  rememberReadQueryTargetClarification({
    actorToken,
    resolution: {
      status: 'ambiguous',
      target: 'Zilio Group Srl',
      candidates: [
        {
          entityId: 'customers',
          entityLabel: 'clienti',
          entitySingular: 'cliente',
          name: 'Zilio Group Srl',
          source: 'catalog',
          filter: {field: 'id', operator: 'equals', value: 'customer-zilio'},
        },
        {
          entityId: 'groups',
          entityLabel: 'gruppi',
          entitySingular: 'gruppo',
          name: 'Zilio Group Srl',
          source: 'catalog',
          filter: {field: 'id', operator: 'equals', value: 'group-zilio'},
        },
      ],
    },
  })

  const selection = resolvePendingReadQueryTargetClarification({
    actorToken,
    message: 'gruppo',
  })

  assert.equal(selection.status, 'resolved')
  assert.equal(selection.resolution.entityId, 'groups')
  assert.equal(selection.resolution.filter.value, 'group-zilio')
})

test('chiarimento entità: accetta il numero della opzione', () => {
  clearAllPendingReadQueryTargetClarifications()
  const actorToken = 'clarification-number'

  rememberReadQueryTargetClarification({
    actorToken,
    resolution: {
      status: 'ambiguous',
      target: 'Webcloud',
      candidates: [
        {
          entityId: 'providers',
          entityLabel: 'fornitori',
          entitySingular: 'fornitore',
          name: 'Webcloud',
          source: 'catalog',
          filter: {field: 'id', operator: 'equals', value: 'provider-webcloud'},
        },
        {
          entityId: 'groups',
          entityLabel: 'gruppi',
          entitySingular: 'gruppo',
          name: 'Webcloud',
          source: 'catalog',
          filter: {field: 'id', operator: 'equals', value: 'group-webcloud'},
        },
      ],
    },
  })

  const selection = resolvePendingReadQueryTargetClarification({
    actorToken,
    message: '2',
  })

  assert.equal(selection.status, 'resolved')
  assert.equal(selection.resolution.entityId, 'groups')
})

test('chiarimento entità: una nuova richiesta esplicita abbandona il chiarimento precedente', () => {
  clearAllPendingReadQueryTargetClarifications()
  const actorToken = 'clarification-new-topic'

  rememberReadQueryTargetClarification({
    actorToken,
    resolution: {
      status: 'ambiguous',
      target: 'Zilio Group Srl',
      candidates: [
        {
          entityId: 'customers',
          entityLabel: 'clienti',
          entitySingular: 'cliente',
          name: 'Zilio Group Srl',
          source: 'catalog',
          filter: {field: 'id', operator: 'equals', value: 'customer-zilio'},
        },
        {
          entityId: 'groups',
          entityLabel: 'gruppi',
          entitySingular: 'gruppo',
          name: 'Zilio Group Srl',
          source: 'catalog',
          filter: {field: 'id', operator: 'equals', value: 'group-zilio'},
        },
      ],
    },
  })

  const selection = resolvePendingReadQueryTargetClarification({
    actorToken,
    message: 'dettagli del piano DomProf10',
  })

  assert.equal(selection.status, 'not-applicable')
})


test('interprete universale: riconosce parlami di come richiesta di dettaglio', () => {
  const utterance = parseReadQueryUtterance('parlami di eco-pv.it')

  assert.equal(utterance?.operation, 'detail')
  assert.equal(utterance?.target, 'eco-pv.it')
  assert.equal(utterance?.entityHint, null)
  assert.equal(utterance?.source, 'deterministic-utterance')
})

test('interprete universale: estrae il tipo di entità quando è esplicito', () => {
  const utterance = parseReadQueryUtterance('raccontami del piano DomProf170 NoSSL')

  assert.equal(utterance?.operation, 'detail')
  assert.equal(utterance?.target, 'DomProf170 NoSSL')
  assert.equal(utterance?.entityHint, 'plans')
})

test('interprete universale: comprende varianti conversazionali comuni', () => {
  const cases = [
    ['che mi dici di MisterDomain?', 'MisterDomain'],
    ['vorrei sapere qualcosa su Zilio Group Srl', 'Zilio Group Srl'],
    ['spiegami meglio l’add-on SendInItalyIPDed', 'SendInItalyIPDed'],
    ['cosa sai di DomProf10?', 'DomProf10'],
  ]

  for (const [message, target] of cases) {
    const utterance = parseReadQueryUtterance(message)
    assert.equal(utterance?.operation, 'detail', message)
    assert.equal(utterance?.target, target, message)
  }
})

test('interprete universale: non sottrae le richieste di modifica', () => {
  assert.equal(
    parseReadQueryUtterance('imposta la scadenza di eco-pv.it al 3 marzo 2028'),
    null
  )
  assert.equal(parseReadQueryUtterance('rinnova eco-pv.it'), null)
})

test('interprete universale: usa Ollama solo come fallback strutturato', async () => {
  let calls = 0
  const utterance = await interpretReadQueryUtterance({
    message: 'Mi fai un quadro generale su eco-pv.it?',
    callLlm: async () => {
      calls += 1
      return JSON.stringify({
        operation: 'detail',
        target: 'eco-pv.it',
        entityHint: null,
        contextual: false,
        confidence: 0.96,
      })
    },
  })

  assert.equal(calls, 1)
  assert.equal(utterance?.operation, 'detail')
  assert.equal(utterance?.target, 'eco-pv.it')
  assert.equal(utterance?.source, 'semantic-utterance')
})

test('resolver universale: parlami di risolve il servizio senza passare dalla lista', async () => {
  const readUtterance = parseReadQueryUtterance('parlami di eco-pv.it')
  const resolution = await resolveReadQueryDetailTarget({
    message: 'parlami di eco-pv.it',
    readUtterance,
    services,
    options,
  })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.entityId, 'services')
  assert.equal(resolution.name, 'eco-pv.it')
})

test('resolver universale: il suggerimento esplicito limita la ricerca ai piani', async () => {
  const readUtterance = parseReadQueryUtterance('parlami del piano DomProf170 NoSSL')
  const resolution = await resolveReadQueryDetailTarget({
    message: 'parlami del piano DomProf170 NoSSL',
    readUtterance,
    services,
    options,
  })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.entityId, 'plans')
  assert.equal(resolution.name, 'DomProf170 NoSSL')
})

test('planner universale: usa una richiesta conversazionale contestuale', async () => {
  const history = [
    {
      role: 'assistant',
      data: {
        type: 'read-query-result',
        entity: 'addons',
        operation: 'list',
        total: 2,
        shown: 2,
        offset: 0,
        limit: 20,
        hasMore: false,
        items: [
          {id: 'addon-one', name: 'Primo add-on'},
          {id: 'addon-two', name: 'Secondo add-on'},
        ],
        plan: {
          type: 'read-query-plan',
          operation: 'list',
          entity: 'addons',
          filters: [],
          sort: [{field: 'name', direction: 'asc'}],
          limit: 20,
          offset: 0,
        },
      },
    },
  ]
  const message = 'parlami del secondo'
  const readUtterance = parseReadQueryUtterance(message)
  const plan = await planReadQuery({
    message,
    history,
    readUtterance,
    allowSemantic: false,
  })

  assert.equal(plan.entity, 'addons')
  assert.equal(plan.operation, 'detail')
  assert.deepEqual(plan.filters, [
    {field: 'id', operator: 'equals', value: 'addon-two'},
  ])
})

test('chiarimento universale: parlami di un nuovo target abbandona il chiarimento precedente', () => {
  clearAllPendingReadQueryTargetClarifications()
  const actorToken = 'clarification-universal-new-topic'

  rememberReadQueryTargetClarification({
    actorToken,
    resolution: {
      status: 'ambiguous',
      target: 'Zilio Group Srl',
      candidates: [
        {
          entityId: 'customers',
          entityLabel: 'clienti',
          entitySingular: 'cliente',
          name: 'Zilio Group Srl',
          source: 'catalog',
          filter: {field: 'id', operator: 'equals', value: 'customer-zilio'},
        },
        {
          entityId: 'groups',
          entityLabel: 'gruppi',
          entitySingular: 'gruppo',
          name: 'Zilio Group Srl',
          source: 'catalog',
          filter: {field: 'id', operator: 'equals', value: 'group-zilio'},
        },
      ],
    },
  })

  const message = 'parlami del piano DomProf170 NoSSL'
  const selection = resolvePendingReadQueryTargetClarification({
    actorToken,
    message,
    readUtterance: parseReadQueryUtterance(message),
  })

  assert.equal(selection.status, 'not-applicable')
})
