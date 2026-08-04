import test from 'node:test'
import assert from 'node:assert/strict'

import {planReadQuery, getPreviousReadQueryState} from '../src/modules/facile/renewals/readQueryPlanner.js'
import {executeReadQuery} from '../src/modules/facile/renewals/readQueryExecutor.js'
import {buildReadQueryReply} from '../src/modules/facile/renewals/readQueryFormatters.js'
import {getReadEntityRegistry} from '../src/modules/facile/renewals/readEntityRegistry.js'
import {validateReadQueryPlan} from '../src/modules/facile/renewals/readQueryContract.js'

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
        },
        addons: [
          {
            id: 'addon-1',
            addonId: 'plan-addon-1',
            name: 'Backup 100 GB',
            resources: [{id: 'resource-backup', name: 'Spazio backup', amount: 100}],
            priceFinal: 50,
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
