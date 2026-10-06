import assert from 'node:assert/strict'
import {after, before, beforeEach, test} from 'node:test'
import {once} from 'node:events'
import http from 'node:http'
import express from 'express'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {env} from '../src/config/env.js'
import chatRouter from '../src/routes/chat.js'
import {createAuthTokenMiddleware} from '../src/middlewares/authToken.js'
import {getModuleById, getRegisteredTools} from '../src/modules/registry.js'
import {assertAutomaticToolPolicy, validateToolArguments} from '../src/core/tools/toolContract.js'
import {searchRenewalsPlans, renewalsSearchPlansTool as tool} from '../src/modules/facile/renewals/planSearch.js'
import {attachChatPresentation} from '../src/core/presentation/chatPresentation.js'

const principal = {id: 'operator', source: 'crm'}, credentials = {crm: 'fixture'}
const providers = [{id: 's1', name: 'Aruba'}, {id: 's2', name: ' Webcloud  Italia '}]
const plans = Array.from({length: 57}, (_, i) => ({id: `p${String(i).padStart(2, '0')}`,
  name: `Piano ${String(i).padStart(2, '0')}`, supplier: providers[i % 3 ? 0 : 1],
  resources: [{id: 'r1', amount: 10}], priceEntries: [{price: 100}], prices: [100],
  description: 'PRIVATE_DESCRIPTION', priceListVersionNames: ['PRIVATE_LIST']})).reverse()
let reads, requests, legacy, providerRows, planRows, failure, choice, args, decision
function catalog(query) {
  reads.push(structuredClone(query))
  let rows = query.entity === 'providers' ? providerRows : planRows
  if (query.filters.length) rows = rows.filter(row => row.supplier?.id === query.filters[0].value)
  const items = rows.slice(query.offset, query.offset + query.limit)
  return {ok: true, source: 'catalog', sourceScope: 'complete-master-data', entity: query.entity,
    total: rows.length, items, offset: query.offset, hasMore: query.offset + items.length < rows.length,
    nextOffset: query.offset + items.length}
}
const queryCatalog = async query => catalog(query)
let model, datasource, server, url
const originalEnv = {ollamaBaseUrl: env.ollamaBaseUrl, renewalsApiBaseUrl: env.renewalsApiBaseUrl, crmToken: env.crmToken}
const module = getModuleById('facile.renewals'), originalRoutes = module.routes
before(async () => {
  datasource = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Connection', 'close')
    assert.equal(req.url, '/catalog/query')
    if (failure === 'execution') {res.statusCode = 500; return res.end(JSON.stringify({error: 'PRIVATE_DATASOURCE'}))}
    res.end(JSON.stringify(catalog(JSON.parse(raw))))
  })
  datasource.listen(0, '127.0.0.1'); await once(datasource, 'listening')
  model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const request = JSON.parse(raw); requests.push(request)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({message: request.format
      ? {role: 'assistant', content: JSON.stringify({stateMode: decision, entityReference: ''})}
      : {role: 'assistant', content: '', tool_calls: [{function: {name: choice, arguments: args}}]}}))
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  env.ollamaBaseUrl = `http://127.0.0.1:${model.address().port}`
  env.renewalsApiBaseUrl = `http://127.0.0.1:${datasource.address().port}`; env.crmToken = 'fixture'
  module.routes = {...module.routes, chat: async (_req, res) => {legacy++; res.json({ok: true, reply: 'legacy'})}}
  const app = express(); app.use(express.json())
  app.use(createAuthTokenMiddleware({validateCrmToken: async () => principal})); app.use('/api/chat', chatRouter)
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); url = `http://127.0.0.1:${server.address().port}`
})
beforeEach(() => {
  reads = []; requests = []; legacy = 0; providerRows = structuredClone(providers); planRows = structuredClone(plans)
  failure = null; choice = tool.name; args = {supplier: 'Aruba'}; decision = 'switch'
})
after(async () => {
  Object.assign(env, originalEnv); module.routes = originalRoutes
  for (const item of [model, datasource, server]) {item.closeAllConnections(); await new Promise(resolve => item.close(resolve))}
})
async function post(message, history = [], moduleId = 'facile', crm = 'fixture') {
  const response = await fetch(`${url}/api/chat`, {method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: 'Bearer fixture', 'X-Webcloud-Credential-Crm': crm,
  }, body: JSON.stringify({moduleId, message, history})})
  assert.equal(response.status, 200); return response.json()
}
const historyFor = result => [{role: 'assistant', content: result.reply, data: result.data, meta: result.meta}]

test('F4: registration validates the dedicated read tool and strict schema', () => {
  assert.equal(getRegisteredTools({credentials}).find(item => item.name === tool.name), tool)
  assert.equal(tool.capabilityId, 'facile.renewals.read'); assert.equal(tool.credential, 'crm')
  assert.equal(tool.requiresPrincipal, true); assert.equal(tool.mode, 'read'); assert.equal(tool.risk, 'low')
  assert.deepEqual(Object.keys(tool.definition.function.parameters.properties), ['supplier', 'limit', 'offset'])
  assert.equal(tool.definition.function.parameters.additionalProperties, false)
})
test('F4: unfiltered search projects and sorts the complete backend catalog before pagination', async () => {
  const result = await searchRenewalsPlans({}, {queryCatalog})
  assert.equal(result.type, 'renewals-plans'); assert.equal(result.total, 57); assert.equal(result.shown, 50)
  assert.equal(result.hasMore, true); assert.equal(result.nextOffset, 50)
  assert.equal(result.items[0].id, 'p00'); assert.equal(result.items[49].id, 'p49')
  assert.equal(reads.length, 2); assert.ok(reads.every(q => q.entity === 'plans' && q.filters.length === 0))
  assert.deepEqual(reads[0].sort, [{field: 'name', direction: 'asc'}, {field: 'id', direction: 'asc'}])
})
for (const supplier of ['Aruba', 's1', '  ARUBA  ', '\tAruba\n']) {
  test(`F4: supplier ${JSON.stringify(supplier)} resolves to stable backend ID`, async () => {
    const result = await searchRenewalsPlans({supplier}, {queryCatalog})
    assert.equal(result.total, 38); assert.equal(result.supplier.id, 's1')
    assert.ok(result.items.every(item => item.supplier.id === 's1'))
    assert.deepEqual(reads.at(-1).filters, [{field: 'supplier.id', operator: 'equals', value: 's1'}])
  })
}
test('F4: normalized whitespace in supplier names uses exact matching without fuzzy aliases', async () => {
  assert.equal((await searchRenewalsPlans({supplier: ' WEBCLOUD\t ITALIA '}, {queryCatalog})).total, 19)
  for (const supplier of ['Aru', 'Aruba S.p.A.', 'missing']) {
    reads = []
    const data = await searchRenewalsPlans({supplier}, {queryCatalog})
    assert.equal(data.type, 'clarification'); assert.equal(data.reason, 'renewals-plan-supplier-not-found')
    assert.deepEqual(data.candidates, []); assert.ok(reads.every(q => q.entity === 'providers'))
  }
})
test('F4: blank supplier is rejected before datasource access', async () => {
  await assert.rejects(searchRenewalsPlans({supplier: ' \t '}, {queryCatalog}), {code: 'TOOL_VALIDATION_ERROR'})
  assert.equal(reads.length, 0)
})
test('F4: ambiguous supplier returns candidates; ID disambiguates without arbitrary choice', async () => {
  providerRows = [...providers, {id: 's3', name: ' ARUBA '}]
  const data = await searchRenewalsPlans({supplier: 'Aruba'}, {queryCatalog})
  assert.equal(data.reason, 'renewals-plan-supplier-ambiguous')
  assert.deepEqual(data.candidates.map(x => x.id).sort(), ['s1', 's3'])
  assert.ok(reads.every(q => q.entity === 'providers'))
  assert.equal((await searchRenewalsPlans({supplier: 's1'}, {queryCatalog})).total, 38)
})
test('F4: supplier missing stable ID requires clarification', async () => {
  providerRows = [{name: 'Aruba'}]
  assert.equal((await searchRenewalsPlans({supplier: 'Aruba'}, {queryCatalog})).reason, 'renewals-plan-supplier-id-missing')
  assert.equal(reads.length, 1)
})
test('F4: empty search and out-of-range pagination stay empty', async () => {
  planRows = []
  assert.equal((await searchRenewalsPlans({supplier: 'Aruba'}, {queryCatalog})).total, 0)
  planRows = plans
  const data = await searchRenewalsPlans({supplier: 'Aruba', offset: 100}, {queryCatalog})
  assert.equal(data.total, 38); assert.deepEqual(data.items, []); assert.equal(data.hasMore, false)
})
test('F4: deterministic ordering and public pagination independent of source row order', async () => {
  const first = await searchRenewalsPlans({limit: 7, offset: 50}, {queryCatalog})
  planRows = plans.toReversed()
  assert.deepEqual(await searchRenewalsPlans({limit: 7, offset: 50}, {queryCatalog}), first)
  assert.equal(first.shown, 7); assert.equal(first.items[0].id, 'p50'); assert.equal(first.nextOffset, null)
})
test('F4: same names with distinct IDs stay distinct and duplicates are compacted', async () => {
  planRows = [{id: 'b', name: 'Same'}, {id: 'a', name: 'Same'}, {id: 'a', name: 'Same'}]
  const data = await searchRenewalsPlans({}, {queryCatalog})
  assert.equal(data.total, 2); assert.deepEqual(data.items.map(x => x.id), ['a', 'b'])
})
test('F4: supplier resolution reads every provider page', async () => {
  providerRows = [...Array.from({length: 50}, (_, i) => ({id: `s${i + 10}`, name: `Other ${i}`})), ...providers]
  assert.equal((await searchRenewalsPlans({supplier: 'Aruba'}, {queryCatalog})).total, 38)
  assert.deepEqual(reads.filter(q => q.entity === 'providers').map(q => q.offset), [0, 50])
})
test('F4: supplier filter stays on every backend page and total is stable', async () => {
  planRows = plans.map(item => ({...item, supplier: providers[0]}))
  const data = await searchRenewalsPlans({supplier: 'Aruba', limit: 10, offset: 50}, {queryCatalog})
  assert.equal(data.total, 57); assert.equal(data.shown, 7); assert.equal(data.items[0].id, 'p50')
  const queries = reads.filter(q => q.entity === 'plans')
  assert.deepEqual(queries.map(q => q.offset), [0, 50])
  assert.ok(queries.every(q => q.filters[0].value === 's1'))
  await assert.rejects(searchRenewalsPlans({}, {queryCatalog: async q => ({...catalog(q), total: q.offset ? 58 : 57})}),
    {code: 'RENEWALS_CATALOG_INVALID_RESULT'})
})
for (const invalid of [{supplier: 1}, {resource: 'email'}, {entityType: 'plan'}, {priceMin: 1},
  {sortByPrice: true}, {cheapest: true}, {ranking: 'price'}, {limit: 0}, {limit: 51}, {limit: 1.5}, {offset: -1}]) {
  test(`F4: strict Step A schema rejects ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => validateToolArguments(tool, invalid), {code: 'TOOL_VALIDATION_ERROR'})
  })
}
test('F4: principal, credential and capability checks remain enforced', () => {
  assertAutomaticToolPolicy(tool, {credentials, principal})
  for (const options of [{credentials: {}, principal}, {credentials}, {credentials, principal: {id: 'operator', source: 'other'}}]) {
    assert.throws(() => assertAutomaticToolPolicy(tool, options), {code: 'TOOL_AUTHORIZATION_DENIED'})
  }
  assert.throws(() => assertAutomaticToolPolicy({...tool, capabilityId: 'unknown'}, {credentials, principal}), {code: 'TOOL_CAPABILITY_DENIED'})
  for (const changed of [{mode: 'write'}, {risk: 'high'}]) {
    assert.throws(() => assertAutomaticToolPolicy({...tool, ...changed}, {credentials, principal}), {code: 'TOOL_POLICY_DENIED'})
  }
})
test('F4: backend result must be complete, correctly scoped and respect supplier filter', async () => {
  for (const patch of [{ok: false}, {entity: 'addons'}, {sourceScope: 'service-derived'},
    {offset: 9}, {total: 58, hasMore: false}, {hasMore: true, nextOffset: 0}]) {
    await assert.rejects(searchRenewalsPlans({}, {queryCatalog: async q => ({...catalog(q), ...patch})}))
  }
  await assert.rejects(searchRenewalsPlans({supplier: 'Aruba'}, {queryCatalog: async q => {
    const result = catalog(q)
    if (q.entity === 'plans') result.items[0].supplier = {id: 'wrong', name: 'Wrong'}
    return result
  }}), {code: 'RENEWALS_CATALOG_INVALID_RESULT'})
})
test('F4: tool returns compact modelContent without prices/resources/descriptions/listins', async () => {
  const result = await tool.execute({supplier: 'Aruba', limit: 3})
  assert.equal(result.modelContent.items.length, 3)
  assert.ok(result.modelContent.items.every(item => Object.keys(item).every(key => ['id', 'name', 'supplier'].includes(key))))
  assert.ok(result.modelContent.items.every(item => Object.keys(item.supplier).every(key => ['id', 'name'].includes(key))))
  const serialized = JSON.stringify(result.modelContent)
  for (const key of ['price', 'resource', 'description', 'PRIVATE']) assert.equal(serialized.includes(key), false)
  assert.ok(result.reply.startsWith('Piani trovati: 38.')); assert.ok(result.reply.includes(' · Aruba'))
})
test('F4: compact presentation has only name and optional supplier, all requested cards', () => {
  const data = {type: 'renewals-plans', total: 2, offset: 0,
    items: [{id: 'a', name: 'First', supplier: {id: 's1', name: 'Aruba'}}, {id: 'b', name: 'Second'}]}
  const presentation = attachChatPresentation({data}).data.presentation
  assert.equal(presentation.title, 'Piani trovati: 2')
  assert.deepEqual(presentation.cards, [{id: 'a', title: 'First', details: [{label: 'Fornitore', value: 'Aruba'}]}, {id: 'b', title: 'Second'}])
})
for (const moduleId of ['facile', 'facile.renewals']) {
  test(`F4: POST ${moduleId} executes native search without legacy fallback`, async () => {
    const result = await post('quali piani sono di Aruba?', [], moduleId)
    assert.equal(result.ok, true); assert.equal(result.meta.agentOutcome, 'HANDLED')
    assert.equal(result.meta.terminalTool, tool.name); assert.equal(result.data.total, 38)
    assert.deepEqual(result.meta.toolCalls.map(x => x.name), [tool.name])
    assert.ok(!result.meta.toolErrors?.length); assert.notEqual(result.meta.legacyFallback, true); assert.equal(legacy, 0)
    assert.equal(result.data.presentation.title, 'Piani trovati: 38')
  })
}
for (const stateMode of ['switch', 'refine']) {
  test(`F4: POST list → search uses Step C snapshot without cross-tool arg merge (${stateMode})`, async () => {
    choice = 'renewals_list_entities'; args = {entityType: 'plan', limit: 2, offset: 1}
    const prior = await post('lista dei piani')
    choice = tool.name; args = {supplier: 'Aruba'}; decision = stateMode; requests = []
    const result = await post('quali sono di Aruba?', historyFor(prior))
    assert.deepEqual(result.meta.agentState.args, {supplier: 'Aruba'})
    assert.equal(result.data.limit, 50); assert.equal(result.data.offset, 0); assert.equal(result.data.total, 38)
    assert.ok(requests.some(r => JSON.stringify(r.messages).includes('renewals_list_entities')))
    assert.ok(requests.some(r => r.format)); assert.equal(legacy, 0); assert.ok(!result.meta.toolErrors?.length)
  })
}
test('F4: same-tool pagination refinement preserves supplier', async () => {
  const prior = await post('piani di Aruba')
  args = {limit: 2, offset: 3}; decision = 'refine'
  const result = await post('prossimi', historyFor(prior))
  assert.deepEqual(result.meta.agentState.args, {supplier: 'Aruba', limit: 2, offset: 3})
  assert.ok(result.data.items.every(x => x.supplier.id === 's1'))
})
for (const invalid of ['{broken', {supplier: 'Aruba', resource: 'email'}, {supplier: 'Aruba', limit: 51}]) {
  test(`F4: POST rejects invalid args before datasource without fallback: ${JSON.stringify(invalid)}`, async () => {
    args = invalid
    const result = await post('piani')
    assert.equal(result.ok, false); assert.equal(result.meta.agentOutcome, 'ERROR')
    assert.ok(result.meta.toolErrors.length); assert.equal(reads.length, 0); assert.equal(legacy, 0)
  })
}
test('F4: POST tool error and missing CRM never fall back to legacy', async () => {
  failure = 'execution'
  const result = await post('piani Aruba')
  assert.equal(result.meta.agentOutcome, 'ERROR'); assert.ok(result.meta.toolErrors.length); assert.equal(legacy, 0)
  failure = null; reads = []
  assert.equal((await post('piani Aruba', [], 'facile', '')).meta.agentOutcome, 'ERROR')
  assert.equal(reads.length, 0); assert.equal(legacy, 0)
})
test('F4: ambiguous supplier is a structured successful clarification with no plan query/fallback', async () => {
  providerRows = [...providers, {id: 's3', name: 'Aruba'}]
  const result = await post('piani Aruba')
  assert.equal(result.ok, true); assert.equal(result.data.reason, 'renewals-plan-supplier-ambiguous')
  assert.ok(result.reply.includes('s1') && result.reply.includes('s3'))
  assert.ok(reads.every(q => q.entity === 'providers')); assert.equal(legacy, 0)
})
test('F4: catalog-list contract and protected core/routing/provider files unchanged', () => {
  const catalogTool = getRegisteredTools({credentials}).find(x => x.name === 'renewals_list_entities')
  assert.deepEqual(Object.keys(catalogTool.definition.function.parameters.properties), ['entityType', 'limit', 'offset'])
  for (const path of ['src/modules/facile/renewals/catalogEntities.js', 'src/routes/chat.js',
    'src/core/orchestrator/globalConversation.js', 'src/core/orchestrator/globalChat.js',
    'src/core/orchestrator/agentOutcome.js', 'src/core/tools/agentState.js', 'src/core/tools/proposalGate.js',
    'src/core/tools/toolContract.js', 'src/core/providers/ollamaProvider.js']) {
    assert.equal(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'), execFileSync('git', ['show', `HEAD:${path}`], {encoding: 'utf8'}))
  }
})
