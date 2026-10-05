import {after, before, test} from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import http from 'node:http'

import {env} from '../src/config/env.js'
import {renewalsTools} from '../src/modules/facile/renewals/tools.js'
import {executeGlobalConversation} from '../src/core/orchestrator/globalConversation.js'
import {getAllServices, getSettings} from '../src/modules/facile/renewals/service.js'
import {validateToolArguments} from '../src/core/tools/toolContract.js'

const settings = {analysis_period: 30, renewals_low_thresholds: []}
const services = [
  {
    id: 's1', name: 'alpha.it', dontRenew: false,
    customer: {id: 'c1', name: 'Cliente Zilio', group: {id: 'g1', name: 'Zilio Group'}},
    subscriptions: [{id: 'sub1', endsOn: '2026-12-20', isSupplier: false}],
    renewalsCommunications: [{id: 'm1', type: '1', typeLabel: 'Rinnovo', communicationDate: '2026-09-01'}],
  },
  {
    id: 's2', name: 'beta.it', dontRenew: true,
    customer: {id: 'c1', name: 'Cliente Zilio', group: {id: 'g1', name: 'Zilio Group'}},
    subscriptions: [{id: 'sub2', endsOn: '2026-12-21', isSupplier: false}],
    renewalsCommunications: [{id: 'm2', type: '1', typeLabel: 'Rinnovo', communicationDate: '2026-09-20'}],
  },
  {
    id: 's3', name: 'other.it', dontRenew: false,
    customer: {id: 'c2', name: 'Altro Cliente', group: {id: 'g2', name: 'Altro Gruppo'}},
    subscriptions: [{id: 'sub3', endsOn: '2027-12-20', isSupplier: false}],
    renewalsCommunications: [],
  },
]
const principal = {id: 'operator-1', roleId: null, roleName: null, source: 'crm'}
const credentials = {crm: 'validated-session'}
let server
let originalUrls

before(async () => {
  originalUrls = {renewalsApiBaseUrl: env.renewalsApiBaseUrl, crmDirectusBaseUrl: env.crmDirectusBaseUrl}
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.url.startsWith('/items/settings') ? {data: [settings]} : services))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  env.renewalsApiBaseUrl = url
  env.crmDirectusBaseUrl = url
  await Promise.all([getAllServices({force: true}), getSettings({force: true})])
})

after(async () => {
  Object.assign(env, originalUrls)
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
})

async function executeTool(name, args, options = {}) {
  return executeGlobalConversation({
    message: 'Query di test', credentials, principal,
    listTools: () => renewalsTools,
    callModel: async () => ({role: 'assistant', content: '', tool_calls: [{function: {
      name, arguments: {stateMode: options.history?.length ? 'refine' : 'replace', args},
    }}]}),
    ...options,
  })
}

for (const [dontRenewMode, ids] of [['any', ['s1', 's2']], ['exclude', ['s1']], ['only', ['s2']]]) {
  test(`query servizi conserva dontRenewMode=${dontRenewMode}`, async () => {
    const result = await executeTool('renewals_search_services', {customerOrGroup: 'Zilio Group', expiresYear: 2026, dontRenewMode})
    assert.equal(result.ok, true)
    assert.equal(result.source, 'agent')
    assert.equal(result.data.type, 'service-list')
    assert.equal(result.data.totale, ids.length)
    assert.deepEqual(result.data.items.map(item => item.id).sort(), ids)
    assert.equal(result.data.query.dontRenewMode, dontRenewMode)
    assert.equal(result.meta.terminalTool, 'renewals_search_services')
  })
}

test('query valida servizi mantiene reply, payload e modelContent esistenti', async () => {
  const tool = renewalsTools.find(item => item.name === 'renewals_search_services')
  const args = {customerOrGroup: 'Zilio Group', expiresYear: 2026, dontRenewMode: 'exclude'}
  const direct = await tool.execute(args)
  const agent = await executeTool(tool.name, args)
  assert.deepEqual(Object.keys(direct).sort(), ['data', 'modelContent', 'moduleId', 'ok', 'reply'])
  assert.equal(direct.reply, 'Ho trovato 1 servizi di cliente/gruppo contenente "Zilio Group".')
  assert.deepEqual(agent.data, direct.data)
  assert.equal(agent.reply, direct.reply)
  assert.deepEqual(direct.modelContent, {
    type: 'renewals-service-search-result', total: 1, shown: 1, offset: 0, limit: 20,
    hasMore: false, nextOffset: null, filters: direct.data.query.filters,
    items: [{
      id: 's1', servizio: 'alpha.it', cliente: 'Cliente Zilio', gruppo: 'Zilio Group', piano: null,
      scadenza: '2026-12-20', scadenzaFornitore: null,
      dontRenew: false, toRenew: false, autoRenew: false, hasPlesk: false,
      spazio: {percent: 0, isFull: false, isLow: false}, lastCommunicationDate: '2026-09-01T00:00:00.000Z',
    }],
  })
})

test('query valida comunicazioni mantiene latest, reply e contratto esistente con campi assenti', async () => {
  const tool = renewalsTools.find(item => item.name === 'renewals_search_communications')
  const direct = await tool.execute({latest: true})
  const agent = await executeTool(tool.name, {latest: true})
  const expectedData = {
    type: 'renewals-communications', total: 2, shown: 1, latest: true,
    query: {customerOrGroup: null, service: null, sentAutomatically: null, limit: 1},
    items: [{
      id: 'm2', communicationDate: '2026-09-20', dateCreated: null, type: '1',
      sentAutomatically: null, to: null, subject: null, description: null,
      serviceId: 's2', serviceName: 'beta.it', customerId: 'c1', customerName: 'Cliente Zilio',
      groupId: 'g1', groupName: 'Zilio Group',
    }],
  }
  assert.deepEqual(direct.data, expectedData)
  assert.deepEqual(agent.data, expectedData)
  assert.equal(agent.reply, "L'ultima comunicazione di rinnovo trovata è del 20/09/2026 · per beta.it · Cliente Zilio / Zilio Group · tipo 1.")
  assert.equal(agent.reply, direct.reply)
  assert.deepEqual(direct.modelContent, {
    type: 'renewals-communication-search-result', total: 2, shown: 1, latest: true,
    query: expectedData.query, items: expectedData.items,
  })
})

test('follow-up validi conservano il merge esistente Zilio + anno + exclude', async () => {
  let state = null
  for (const args of [{customerOrGroup: 'Zilio Group'}, {expiresYear: 2026}, {dontRenewMode: 'exclude'}]) {
    const result = await executeTool('renewals_search_services', args, {
      routingSource: state ? 'agent-history' : 'message',
      history: state ? [{role: 'assistant', meta: {agentState: state}}] : [],
    })
    state = result.meta.agentState
    assert.equal(result.ok, true)
  }
  assert.deepEqual(state.args, {customerOrGroup: 'Zilio Group', expiresYear: 2026, dontRenewMode: 'exclude'})
})

test('gli schemi originali sono la sola fonte di tipi, enum e limiti', () => {
  const servicesTool = renewalsTools[0]
  const communicationsTool = renewalsTools[1]
  assert.deepEqual(servicesTool.definition.function.parameters.properties.dontRenewMode.enum, ['any', 'exclude', 'only'])
  assert.equal(Object.hasOwn(servicesTool.definition.function.parameters.properties, 'includeDontRenew'), false)
  assert.throws(() => validateToolArguments(communicationsTool, {latest: 'true'}), /non conformi/)
  assert.throws(() => validateToolArguments(communicationsTool, {limit: 21}), /non conformi/)
  assert.throws(() => validateToolArguments(communicationsTool, {sentAutomatically: 'false'}), /non conformi/)
  assert.deepEqual(validateToolArguments(communicationsTool, {latest: true, sentAutomatically: false, limit: 20}), {
    latest: true, sentAutomatically: false, limit: 20,
  })
})
