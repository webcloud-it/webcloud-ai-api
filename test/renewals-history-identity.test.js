import test from 'node:test'
import assert from 'node:assert/strict'
import {buildCommunicationsIndex, buildCommunicationsContext, buildCommunicationsReply} from '../src/modules/facile/renewals/communications.js'
import {buildReadEntityRecords} from '../src/modules/facile/renewals/readEntityRegistry.js'
import {historicalCommunicationIdentity} from '../src/modules/facile/renewals/communicationIdentity.js'
import {buildRenewalsChatMessages} from '../src/modules/facile/renewals/prompt.js'

const A = {id: 'A', name: 'Historical A', group: {id: 'GA', name: 'Historical GA'}}
const B = {id: 'B', name: 'Current B', group: {id: 'GB', name: 'Current GB'}}
const identity = customer => ({customerId: customer.id, customerName: customer.name,
  groupId: customer.group.id, groupName: customer.group.name, customerSource: 'snapshot', groupSource: 'snapshot'})
const services = [{id: 's1', name: 'domain.test', customer: B, commercialCustomerId: 'B',
  operationalCustomer: A, renewalsCommunications: [{type: '1', communicationDate: '2026-10-06'}],
  renewalsCommunicationsHistory: [
    {id: 'old', type: '1', communicationDate: '2026-01-01', historicalIdentity: identity(A)},
    {id: 'new', type: '1', communicationDate: '2026-10-06', historicalIdentity: identity(B)},
  ]}]

test('AI full history distinguishes historical A, commercial B and operational A', () => {
  const [old, newer] = buildCommunicationsIndex(services)
  assert.equal(old.customerId, 'A')
  assert.equal(old.currentCommercialCustomerId, 'B')
  assert.equal(old.currentOperationalCustomerId, 'A')
  assert.equal(newer.customerId, 'B')
  assert.equal(old.customerSource, 'snapshot')
})
test('AI historical customer/group filters do not use current commercial membership', () => {
  const old = buildCommunicationsContext({services, customerId: 'A', groupId: 'GA'})
  const newer = buildCommunicationsContext({services, customerId: 'B', groupId: 'GB'})
  assert.equal(old.totalCommunications, 1)
  assert.equal(old.items[0].communicationDate, '2026-01-01')
  assert.equal(old.items[0].currentCommercialCustomerId, 'B')
  assert.equal(newer.totalCommunications, 1)
})
test('AI generic read registry attributes each communication historically and exposes current references', () => {
  const [old, newer] = buildReadEntityRecords('communications', {services})
  assert.equal(old.customer.id, 'A')
  assert.equal(old.group.id, 'GA')
  assert.equal(old.currentCommercialCustomer.id, 'B')
  assert.equal(old.currentOperationalCustomer.id, 'A')
  assert.equal(newer.customer.id, 'B')
})
test('older contracts resolve stored scope first and derived operational fallback only when necessary', () => {
  assert.equal(historicalCommunicationIdentity({generationContext: {scope: {type: 'customer', id: 'OLD', label: 'Old'}}}, services[0]).customerId, 'OLD')
  assert.equal(historicalCommunicationIdentity({}, services[0]).customerSource, 'current-fallback')
  assert.equal(historicalCommunicationIdentity({}, {customer: B, commercialCustomerId: 'B', operationalCustomer: null}).customerId, null)
  const [system] = buildRenewalsChatMessages({message: 'storico', payload: {}})
  assert.match(system.content, /identifica il cliente al momento dell’invio/)
  assert.match(system.content, /current-fallback/)
  const legacy = buildCommunicationsContext({services: [{...services[0], renewalsCommunicationsHistory: undefined}]})
  assert.match(buildCommunicationsReply(legacy), /identità storica non verificabile/)
})
