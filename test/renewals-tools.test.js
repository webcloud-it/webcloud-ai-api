import {after, before, test} from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import http from 'node:http'

import {env} from '../src/config/env.js'
import {renewalsTools} from '../src/modules/facile/renewals/tools.js'
import {executeGlobalConversation} from '../src/core/orchestrator/globalConversation.js'
import {getAllServices, getSettings} from '../src/modules/facile/renewals/service.js'
import {validateToolArguments} from '../src/core/tools/toolContract.js'
import {attachChatPresentation} from '../src/core/presentation/chatPresentation.js'

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
let fixtureServices = services
const principal = {id: 'operator-1', roleId: null, roleName: null, source: 'crm'}
const credentials = {crm: 'validated-session'}
let server
let originalUrls

before(async () => {
  originalUrls = {renewalsApiBaseUrl: env.renewalsApiBaseUrl, crmDirectusBaseUrl: env.crmDirectusBaseUrl}
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.url.startsWith('/items/settings') ? {data: [settings]} : fixtureServices))
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
    callModel: async request => request.format
      ? {content: JSON.stringify({stateMode: 'refine', entityReference: ''})}
      : ({role: 'assistant', content: '', tool_calls: [{function: {name, arguments: args}}]}),
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

test('comunicazioni legacy mantengono latest e omettono i campi non disponibili', async () => {
  const tool = renewalsTools.find(item => item.name === 'renewals_search_communications')
  const direct = await tool.execute({latest: true})
  const agent = await executeTool(tool.name, {latest: true})
  const expectedData = {
    type: 'renewals-communications', total: 2, shown: 1, latest: true, coverage: 'latest-per-service-type',
    query: {limit: 1},
    items: [{
      id: 'm2', communicationDate: '2026-09-20', type: '1', typeLabel: 'Rinnovo',
      serviceId: 's2', serviceName: 'beta.it', customerId: 'c1', customerName: 'Cliente Zilio',
      groupId: 'g1', groupName: 'Zilio Group',
    }],
  }
  assert.deepEqual(direct.data, expectedData)
  assert.deepEqual(agent.data, expectedData)
  assert.equal(agent.reply, "L'ultima comunicazione di rinnovo è del 20 settembre 2026, per beta.it, cliente/gruppo Cliente Zilio / Zilio Group. Tipo: Rinnovo. Destinatario non disponibile nei dati. Oggetto non disponibile nei dati. Modalità di invio non disponibile nei dati.")
  assert.equal(agent.reply, direct.reply)
  assert.deepEqual(direct.modelContent, {
    type: 'renewals-communication-search-result', total: 2, shown: 1, latest: true, coverage: 'latest-per-service-type',
    query: expectedData.query, items: expectedData.items,
  })
})

async function withServices(rows, run) {
  fixtureServices = rows
  await getAllServices({force: true})
  try { return await run() }
  finally { fixtureServices = services; await getAllServices({force: true}) }
}

const communicationTool = renewalsTools[1]
const historyRows = [
  {id: 'z', communicationDate: '2026-10-02T15:22:47', type: '1', typeLabel: 'Inviato richiesta rinnovo', sentAutomatically: false, to: 'admin@example.it', subject: 'Rinnovo beta'},
  {id: 'a', communicationDate: '2026-10-02T15:22:47', type: '1', typeLabel: 'Inviato richiesta rinnovo', sentAutomatically: false, to: 'admin@example.it', subject: 'Rinnovo alpha'},
  {id: 'old', communicationDate: '2026-01-01', dateCreated: '2027-01-01', sentAutomatically: true, type: '6', typeLabel: 'Inviato richiesta upgrade'},
  {id: 'undated', dateCreated: '2028-01-01'},
]
const historyService = {...services[0], customer: {...services[0].customer, name: 'Zilio Group'}, renewalsCommunicationsHistory: historyRows}

test('Phase 3A: communications tool filters historical A independently of current B and returns both references', async () => {
  const A = {id: 'A', name: 'Historical A', group: {id: 'GA', name: 'Historical GA'}}
  const B = {id: 'B', name: 'Current B', group: {id: 'GB', name: 'Current GB'}}
  const makeIdentity = c => ({customerId: c.id, customerName: c.name, groupId: c.group.id,
    groupName: c.group.name, customerSource: 'snapshot', groupSource: 'snapshot'})
  await withServices([{...services[0], customer: B, commercialCustomer: B, commercialCustomerId: 'B', operationalCustomer: A,
    renewalsCommunicationsHistory: [
      {...historyRows[0], id: 'old-A', historicalIdentity: makeIdentity(A)},
      {...historyRows[1], id: 'new-B', historicalIdentity: makeIdentity(B)},
    ]}], async () => {
    const older = await communicationTool.execute({customerOrGroup: 'Historical A'})
    const newer = await communicationTool.execute({customerOrGroup: 'Current B'})
    assert.deepEqual(older.data.items.map(r => r.id), ['old-A'])
    assert.deepEqual(newer.data.items.map(r => r.id), ['new-B'])
    assert.equal(older.data.items[0].currentCommercialCustomer.id, 'B')
    assert.equal(older.data.items[0].currentOperationalCustomer.id, 'A')
    assert.match(older.reply, /Historical A/)
  })
})

test('Step D: usa lo storico completo, ordina per communicationDate DESC e risolve le parità per ID', async () => {
  await withServices([historyService], async () => {
    const result = await communicationTool.execute({})
    assert.deepEqual(result.data.items.map(item => item.id), ['a', 'z', 'old', 'undated'])
    assert.equal(result.data.total, 4)
    assert.equal(result.data.coverage, 'history')
    assert.equal(Object.hasOwn(result.data.items[3], 'communicationDate'), false)
    assert.equal(result.data.items.some(item => Object.hasOwn(item, 'dateCreated')), false)
  })
})

test('Step D: latest sceglie un solo record stabile, con label e cliente/gruppo non duplicato', async () => {
  await withServices([historyService], async () => {
    const result = await communicationTool.execute({latest: true, limit: 20})
    assert.equal(result.data.shown, 1)
    assert.equal(result.data.items[0].id, 'a')
    assert.match(result.reply, /2 ottobre 2026 alle 15:22/)
    assert.match(result.reply, /Tipo: Inviato richiesta rinnovo/)
    assert.doesNotMatch(result.reply, /tipo 1|Zilio Group \/ Zilio Group/)
    assert.match(result.reply, /a admin@example.it/)
    assert.match(result.reply, /Oggetto: «Rinnovo alpha»/)
    assert.match(result.reply, /Invio manuale/)
  })
})

for (const [sentAutomatically, expected] of [[true, ['old']], [false, ['a', 'z']]]) {
  test(`Step D: filtro sentAutomatically=${sentAutomatically} applicato ai booleani del datasource`, async () => {
    await withServices([{...historyService, renewalsCommunicationsHistory: historyRows.slice(0, 3)}], async () => {
      const result = await communicationTool.execute({sentAutomatically})
      assert.deepEqual(result.data.items.map(item => item.id), expected)
      assert.equal(result.data.query.sentAutomatically, sentAutomatically)
    })
  })
}

test('Step D: modalità mancante blocca il filtro senza false risposte vuote né fallback', async () => {
  const result = await executeTool(communicationTool.name, {sentAutomatically: true}, {fallbackOnNoTool: true})
  assert.notEqual(result, null)
  assert.notEqual(result.data.type, 'renewals-communications')
  assert.equal(result.meta.toolErrors[0].code, 'COMMUNICATIONS_FIELD_UNAVAILABLE')
})

test('Step D: customerOrGroup e service restringono lo storico verificato', async () => {
  await withServices([historyService, {...services[2], renewalsCommunicationsHistory: [historyRows[0]]}], async () => {
    const grouped = await communicationTool.execute({customerOrGroup: 'Zilio Group'})
    assert.equal(grouped.data.total, 4)
    assert.equal(grouped.data.items.every(item => item.customerId === 'c1'), true)
    const named = await communicationTool.execute({service: 'other.it'})
    assert.equal(named.data.total, 1)
    assert.equal(named.data.items[0].serviceId, 's3')
  })
})

test('Step D: allowlist esclude HTML, generation_context, descrizioni non verificate e campi tecnici', async () => {
  await withServices([{...historyService, renewalsCommunicationsHistory: [{...historyRows[0],
    html_content: 'PRIVATE_BODY', htmlContent: 'PRIVATE_BODY', generation_context: 'PRIVATE_CONTEXT',
    generationContext: 'PRIVATE_CONTEXT', description: 'UNVERIFIED_DESCRIPTION', date_created: '2027-01-01',
  }]}], async () => {
    const result = await communicationTool.execute({latest: true})
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY|PRIVATE_CONTEXT|UNVERIFIED_DESCRIPTION|date_created|dateCreated/)
  })
})

test('Step D: un record senza metadati facoltativi resta consultabile e non inventa valori', async () => {
  await withServices([{id: 'sparse', renewalsCommunicationsHistory: [{id: 'only-id'}]}], async () => {
    const result = await communicationTool.execute({latest: true})
    assert.deepEqual(result.data.items, [{id: 'only-id', serviceId: 'sparse'}])
    assert.match(result.reply, /non ha una data disponibile/)
    assert.match(result.reply, /Destinatario non disponibile/)
    assert.match(result.reply, /Oggetto non disponibile/)
    assert.match(result.reply, /Modalità di invio non disponibile/)
    assert.doesNotMatch(result.reply, /null|undefined/)
  })
})

test('Step D: lista dal vecchio datasource dichiara la copertura aggregata', async () => {
  const result = await communicationTool.execute({})
  assert.equal(result.data.coverage, 'latest-per-service-type')
  assert.match(result.reply, /non lo storico completo/)
})

test('Step D: limite, riepilogo testuale, card e campione per il modello rimangono coerenti', async () => {
  await withServices([{...historyService, renewalsCommunicationsHistory: Array.from({length: 25}, (_, index) => ({...historyRows[0], id: `m-${index}`}))}], async () => {
    const result = await communicationTool.execute({limit: 20})
    const presented = attachChatPresentation(result)
    assert.equal(result.data.total, 25)
    assert.equal(result.data.shown, 20)
    assert.equal(presented.data.presentation.cards.length, 20)
    assert.equal(result.modelContent.items.length, 10)
    assert.match(result.reply, /le 20 più recenti; ecco un riepilogo delle prime 5/)
  })
})

test('Step D: regressione servizi 83 → 27 → 24 attraverso tool e stato Step C', async () => {
  const rows = Array.from({length: 83}, (_, index) => ({...services[0], id: `service-${index}`, name: `service-${index}.it`,
    dontRenew: index >= 24 && index < 27,
    subscriptions: [{id: `subscription-${index}`, endsOn: index < 27 ? '2026-12-20' : '2027-12-20', isSupplier: false}],
  }))
  await withServices(rows, async () => {
    let state = null
    for (const [args, expected] of [[{customerOrGroup: 'Zilio Group'}, 83], [{expiresYear: 2026}, 27], [{dontRenewMode: 'exclude'}, 24]]) {
      const result = await executeTool('renewals_search_services', args, {history: state ? [{role: 'assistant', meta: {agentState: state}}] : []})
      assert.equal(result.data.totale, expected)
      assert.equal(result.meta.toolErrors, undefined)
      state = result.meta.agentState
    }
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
