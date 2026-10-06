import assert from 'node:assert/strict'
import test from 'node:test'
import {normalizeRenewalsService, operationalCustomer, commercialCustomer} from '../src/modules/facile/renewals/customerReferences.js'
import {buildServiceSnapshot} from '../src/modules/facile/renewals/snapshots.js'
import {buildCommunicationsIndex} from '../src/modules/facile/renewals/communications.js'
import {buildRenewalsChatMessages} from '../src/modules/facile/renewals/prompt.js'
import {buildReadEntityRecords} from '../src/modules/facile/renewals/readEntityRegistry.js'

const A = {id: 'A', name: 'Operativo', group: {id: 'GA', name: 'GA'}}
const B = {id: 'B', name: 'Commerciale', group: {id: 'GB', name: 'GB'}}
test('incomplete or unreadable separated contracts reject A instead of commercial fallback', () => {
  for (const partial of [
    {commercialCustomerId: 'B'}, {explicitCommercialCustomerId: 'B'},
    {commercialCustomerId: 'B', commercialCustomer: null},
    {commercialCustomerId: 'B', commercialCustomer: A},
    {commercialCustomerId: 'B', explicitCommercialCustomerId: 'C', commercialCustomer: B},
    {operationalCustomer: A},
  ]) {
    const service = {id: 's', customer: A, ...partial}
    assert.throws(() => normalizeRenewalsService(service), error => error.statusCode === 403)
    assert.throws(() => commercialCustomer(service), /non leggibile/)
  }
  assert.equal(commercialCustomer({customer: A, commercialCustomer: A, commercialCustomerId: 'A', explicitCommercialCustomerId: null}), A)
})
test('AI current renewals context treats customer as B and exposes operational A', () => {
  const input = {id: 's1', customer: A, commercialCustomer: B, commercialCustomerId: 'B',
    operationalCustomer: A, operationalCustomerId: 'A', subscriptions: []}
  const service = normalizeRenewalsService(input)
  assert.equal(service.customer, B)
  const snapshot = buildServiceSnapshot(service, [], 30)
  assert.equal(snapshot.customerId, 'B')
  assert.equal(snapshot.groupId, 'GB')
  assert.equal(snapshot.operationalCustomerId, 'A')
  assert.equal(snapshot.operationalCustomerName, 'Operativo')
  assert.equal(input.customer, A)
})
test('legacy API contracts remain compatible but separated contracts never infer A from B', () => {
  const legacy = {id: 's1', customer: A}
  assert.equal(normalizeRenewalsService(legacy), legacy)
  assert.equal(operationalCustomer(legacy), A)
  assert.equal(operationalCustomer({customer: B, commercialCustomerId: 'B'}), null)
})
test('historical communications retain their preceding attribution until phase 3', () => {
  const services = [{id: 's1', customer: B, commercialCustomer: B,
    operationalCustomer: A, commercialCustomerId: 'B', renewalsCommunications: [{type: '1', communicationDate: '2026-10-01'}]}]
  const [history] = buildCommunicationsIndex(services)
  assert.equal(history.customerId, 'A')
  assert.equal(history.groupId, 'GA')
  const [record] = buildReadEntityRecords('communications', {services})
  assert.equal(record.customer.id, 'A')
  assert.equal(record.group.id, 'GA')
  const [current] = buildReadEntityRecords('services', {services})
  assert.equal(current.customer.id, 'B')
  assert.equal(current.operationalCustomer.id, 'A')
})
test('AI prompt distinguishes commercial offers from operational Send in Italy/Plesk', () => {
  const [system] = buildRenewalsChatMessages({message: 'servizio', payload: {}})
  assert.match(system.content, /customer\/cliente indica il cliente commerciale/)
  assert.match(system.content, /esclusivamente operationalCustomer\/operationalCustomerId/)
})
