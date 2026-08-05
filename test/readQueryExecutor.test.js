import assert from 'node:assert/strict'
import test from 'node:test'

import {executeReadQuery} from '../src/modules/facile/renewals/readQueryExecutor.js'
import {canExecuteReadQueryFromCatalog} from '../src/modules/facile/renewals/readEntityRegistry.js'

const services = [
  {
    id: 'service-1',
    name: 'example.it',
    customer: {id: 'customer-1', name: 'Cliente Uno'},
    subscriptions: [
      {
        id: 'subscription-1',
        isSupplier: false,
        plan: {
          id: 'plan-1',
          name: 'DomProf170',
          supplier: {id: 'supplier-1', name: 'MisterDomain'},
        },
      },
    ],
  },
]

const plan = {
  operation: 'list',
  entity: 'providers',
  filters: [],
  sort: [{field: 'name', direction: 'asc'}],
  limit: 20,
  offset: 0,
  source: 'deterministic',
}

test('usa il catalogo completo e distingue record usati e inutilizzati', () => {
  const result = executeReadQuery({
    plan,
    services,
    options: {},
    catalogResult: {
      ok: true,
      source: 'catalog',
      sourceScope: 'complete-master-data',
      catalogVersion: 'renewals-v1',
      entity: 'providers',
      operation: 'list',
      total: 2,
      shown: 2,
      offset: 0,
      limit: 20,
      nextOffset: 2,
      previousOffset: 0,
      hasMore: false,
      items: [
        {id: 'supplier-1', name: 'MisterDomain'},
        {id: 'supplier-2', name: 'Fornitore inutilizzato'},
      ],
    },
  })

  assert.equal(result.dataSource, 'catalog')
  assert.equal(result.items[0].usage.status, 'used')
  assert.equal(result.items[0].serviceCount, 1)
  assert.equal(result.items[1].usage.status, 'unused')
  assert.equal(result.items[1].serviceCount, undefined)
})

test('mantiene il percorso operativo storico quando il catalogo non è applicabile', () => {
  const result = executeReadQuery({plan, services, options: {}})

  assert.equal(result.dataSource, 'operational-services')
  assert.equal(result.total, 1)
  assert.equal(result.items[0].name, 'MisterDomain')
})

test('usa il catalogo solo per filtri e ordinamenti autorizzati', () => {
  assert.equal(canExecuteReadQueryFromCatalog(plan), true)
  assert.equal(
    canExecuteReadQueryFromCatalog({
      ...plan,
      filters: [{field: 'expiryYears', operator: 'in', value: [2027]}],
    }),
    false
  )
  assert.equal(
    canExecuteReadQueryFromCatalog({
      ...plan,
      entity: 'services',
    }),
    false
  )
})
