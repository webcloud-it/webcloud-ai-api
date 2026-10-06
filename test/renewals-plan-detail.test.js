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
import {getRenewalsPlan, normalizePlanDetail, planPriceLabel, renewalsGetPlanTool as tool} from '../src/modules/facile/renewals/planDetail.js'
import {attachChatPresentation} from '../src/core/presentation/chatPresentation.js'

const principal = {id: 'operator', source: 'crm'}, credentials = {crm: 'fixture'}
const supplier = {id: 's1', name: 'Aruba'}, version = {id: 'v1', name: 'Standard', version: 1}
const base = {kind: 'base', isAddon: false, type: '1', supplier, description: null, duration: null,
  resources: [], servicesTypesIn: [], servicesTypesOut: [], priceEntries: [], missingPrice: true}
const rich = {...base, id: 'p1', name: 'Unique', supplier: {...supplier, name: '  Aruba  ', internal: 'PRIVATE'},
  description: 'Verified hosting', duration: 12, activationFee: null,
  resources: [{id: 'r1', name: ' Space ', category: ' hosting ', unitOfMeasurement: ' GB ', amount: '5.00', key: 'PRIVATE', addonStrategy: '1'},
    {id: 'r2', name: 'Mailboxes', amount: '0.00', unitOfMeasurement: 'caselle'}],
  resourceNames: ['Space', 'Mailboxes'], servicesTypesIn: [{id: 't1', name: ' Incoming ', macro: {name: 'PRIVATE'}}],
  servicesTypesOut: [{id: 't2', name: 'Outgoing'}], serviceTypeInNames: ['Incoming'], serviceTypeOutNames: ['Outgoing'],
  priceEntries: [{id: 'e1', price: 470, priceListVersion: version},
    {id: 'e2', price: 438, priceListVersion: {id: 'v2', name: 'Customer list', version: 4}},
    {id: 'e3', price: null, priceListVersion: version}],
  prices: [470, 438], priceListVersionNames: ['Standard', 'Customer list'], missingPrice: false}
const missing = {...base, id: 'p2', name: 'Missing', priceEntries: [{id: 'e4', price: null, priceListVersion: version}]}
const fixtures = [rich, missing, {...base, id: 'p3', name: 'Duplicate'},
  {...base, id: 'p4', name: ' Duplicate ', supplier: {id: 's2', name: 'Other'}},
  ...Array.from({length: 55}, (_, i) => ({...base, id: `id${i}`, name: `Plan ${i}`}))]
let reads, requests, legacy, rows, failure, choice, args, decision, model, datasource, server, url
function catalog(query) {
  reads.push(structuredClone(query))
  let items = query.entity === 'providers' ? [supplier] : rows
  for (const filter of query.filters) {
    items = items.filter(row => filter.field === 'id' ? row.id === filter.value : row.supplier?.id === filter.value)
  }
  const total = items.length; items = items.slice(query.offset, query.offset + query.limit)
  return {ok: true, source: 'catalog', sourceScope: 'complete-master-data', entity: query.entity,
    total, items, offset: query.offset, hasMore: query.offset + items.length < total, nextOffset: query.offset + items.length}
}
const queryCatalog = async query => catalog(query)
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
  reads = []; requests = []; legacy = 0; rows = structuredClone(fixtures); failure = null
  choice = tool.name; args = {plan: 'Unique'}; decision = 'switch'
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

test('F5: dedicated strict read tool is registered with unchanged principal/capability policy', () => {
  assert.equal(getRegisteredTools({credentials}).find(item => item.name === tool.name), tool)
  assert.equal(tool.mode, 'read'); assert.equal(tool.risk, 'low'); assert.equal(tool.credential, 'crm')
  assert.equal(tool.requiresPrincipal, true); assert.equal(tool.capabilityId, 'facile.renewals.read')
  assert.equal(tool.terminal, true); assert.equal(tool.stateful, false)
  assert.deepEqual(Object.keys(tool.definition.function.parameters.properties), ['plan'])
})
for (const plan of ['p1', 'Unique', '  UNIQUE  ', '\tUnique\n']) {
  test(`F5: exact ID/normalized name resolves ${JSON.stringify(plan)} to one backend detail`, async () => {
    const data = await getRenewalsPlan({plan}, {queryCatalog})
    assert.equal(data.id, 'p1'); assert.equal(data.type, 'renewals-plan')
    assert.equal(reads.filter(q => q.operation === 'list').length, 2)
    assert.deepEqual(reads.at(-1).filters, [{field: 'id', operator: 'equals', value: 'p1'}])
    assert.equal(reads.at(-1).operation, 'detail'); assert.equal(reads.at(-1).limit, 1)
  })
}
test('F5: ID match takes precedence over a different plan with that name', async () => {
  rows.push({...base, id: 'p5', name: 'p1'})
  assert.equal((await getRenewalsPlan({plan: 'p1'}, {queryCatalog})).name, 'Unique')
})
for (const plan of ['Unknown', 'Uni', 'addon-id']) {
  test(`F5: unknown name/partial name/addon ID returns NOT_FOUND: ${plan}`, async () => {
    const result = await getRenewalsPlan({plan}, {queryCatalog})
    assert.equal(result.type, 'clarification'); assert.equal(result.code, 'NOT_FOUND')
    assert.deepEqual(result.candidates, []); assert.ok(reads.every(q => q.operation === 'list'))
  })
}
test('F5: duplicate names require explicit ID; neither candidate is selected arbitrarily', async () => {
  const result = await getRenewalsPlan({plan: ' duplicate '}, {queryCatalog})
  assert.equal(result.code, 'AMBIGUOUS'); assert.equal(result.total, 2)
  assert.deepEqual(result.candidates.map(x => x.id).sort(), ['p3', 'p4'])
  assert.ok(result.candidates.every(x => Object.keys(x).every(k => ['id', 'name', 'supplier'].includes(k))))
  assert.ok(reads.every(q => q.operation === 'list'))
  assert.equal((await getRenewalsPlan({plan: 'p4'}, {queryCatalog})).supplier.name, 'Other')
})
test('F5: normalization projects supplier, optional description and verified duration in months', () => {
  const data = normalizePlanDetail(rich)
  assert.deepEqual(data.supplier, supplier); assert.equal(data.description, 'Verified hosting'); assert.equal(data.durationMonths, 12)
  const empty = normalizePlanDetail(missing)
  assert.equal(Object.hasOwn(empty, 'description'), false); assert.equal(Object.hasOwn(empty, 'durationMonths'), false)
})
test('F5: resources preserve quantities including zero, category and unit without internal joins', () => {
  const data = normalizePlanDetail(rich)
  assert.deepEqual(data.resources, [{id: 'r2', name: 'Mailboxes', unit: 'caselle', amount: 0},
    {id: 'r1', name: 'Space', category: 'hosting', unit: 'GB', amount: 5}])
  assert.deepEqual(data.serviceTypesIn, [{id: 't1', name: 'Incoming'}])
  assert.deepEqual(data.serviceTypesOut, [{id: 't2', name: 'Outgoing'}])
  assert.deepEqual(normalizePlanDetail(missing).resources, [])
})
test('F5: prices preserve row identity, list/version and null-amount row, never select one price', () => {
  const data = normalizePlanDetail(rich)
  assert.equal(data.pricing.missing, false); assert.equal(data.pricing.entries.length, 3)
  assert.deepEqual(data.pricing.entries.find(x => x.id === 'e1'), {id: 'e1', amount: 470, priceListVersion: version})
  assert.deepEqual(data.pricing.entries.find(x => x.id === 'e3'), {id: 'e3', priceListVersion: version})
  assert.equal(Object.hasOwn(data, 'price'), false); assert.equal(Object.hasOwn(data, 'prices'), false)
  assert.equal(Object.hasOwn(data.pricing, 'amount'), false)
})
test('F5: missing price retains known list/version without fabricated amount', async () => {
  const data = normalizePlanDetail(missing)
  assert.deepEqual(data.pricing, {missing: true, entries: [{id: 'e4', priceListVersion: version}]})
  const result = await tool.execute({plan: 'Missing'})
  assert.ok(result.reply.includes('Prezzo non disponibile nel catalogo.'))
  assert.ok(result.reply.includes('Standard · versione 1: importo non disponibile'))
})
test('F5: no price entries gives genuine missing price, zero price remains available', () => {
  assert.deepEqual(normalizePlanDetail({...base, id: 'empty', name: 'Empty'}).pricing, {missing: true, entries: []})
  assert.equal(normalizePlanDetail({...rich, priceEntries: [{id: 'z', price: 0}]}).pricing.entries[0].amount, 0)
})
test('F5: numeric zero IDs and price precision are preserved; contradictory addon type rejected', () => {
  assert.equal(normalizePlanDetail({...rich, id: 0}).id, '0')
  assert.ok(planPriceLabel({amount: 0.125}).endsWith('0,125'))
  assert.throws(() => normalizePlanDetail({...rich, type: '2'}), {code: 'RENEWALS_PLAN_INVALID_RESULT'})
})
test('F5: resource/price ordering and exact duplicate normalization are deterministic', () => {
  const reversed = {...rich, resources: rich.resources.toReversed(), priceEntries: rich.priceEntries.toReversed()}
  assert.deepEqual(normalizePlanDetail(reversed), normalizePlanDetail(rich))
  assert.deepEqual(normalizePlanDetail({...rich, priceEntries: [...rich.priceEntries, rich.priceEntries[0]]}), normalizePlanDetail(rich))
})
test('F5: controlled normalized modelContent excludes raw duplicate arrays and internal fields', async () => {
  const result = await tool.execute({plan: 'Unique'})
  assert.deepEqual(result.modelContent, result.data)
  for (const key of ['prices', 'priceEntries', 'resourceNames', 'priceListVersionNames', 'servicesTypesIn', 'serviceTypeInNames', 'PRIVATE', 'addonStrategy', 'activationFee']) {
    assert.equal(JSON.stringify(result.modelContent).includes('"' + key + '"'), false)
  }
  assert.ok(result.reply.includes('più voci')); assert.ok(result.reply.includes('438,00')); assert.ok(result.reply.includes('470,00'))
})
for (const patch of [{kind: 'addon', isAddon: true}, {id: null}, {name: null}, {missingPrice: true},
  {duration: 'invalid'}, {resources: null}, {priceEntries: null}, {priceEntries: [{price: 'bad'}]},
  {resources: [{name: 'Space', amount: 'bad'}]}, {description: 'x'.repeat(2001)}, {resources: Array(51).fill({name: 'Space'})}]) {
  test(`F5: malformed/oversized/contradictory detail is rejected: ${Object.keys(patch).join(',')}`, () => {
    assert.throws(() => normalizePlanDetail({...rich, ...patch}))
  })
}
test('F5: incomplete or incorrectly filtered backend pages never resolve a plan', async () => {
  for (const patch of [{total: 100, hasMore: false}, {entity: 'addons'}, {sourceScope: 'service-derived'}, {offset: 1}]) {
    await assert.rejects(getRenewalsPlan({plan: 'Unique'}, {queryCatalog: async q => ({...catalog(q), ...patch})}))
  }
  await assert.rejects(getRenewalsPlan({plan: 'Unique'}, {queryCatalog: async q => {
    const result = catalog(q)
    if (q.operation === 'detail') result.items[0].id = 'wrong'
    return result
  }}), {code: 'RENEWALS_PLAN_INVALID_RESULT'})
})
test('F5: dedicated presentation shows resource quantities and every price/list/version without null', () => {
  const data = normalizePlanDetail(rich), presentation = attachChatPresentation({data}).data.presentation
  assert.equal(presentation.title, 'Piano Unique'); assert.equal(presentation.cards.length, 1)
  const values = presentation.cards[0].details.map(x => x.value)
  assert.ok(values.includes('12 mesi')); assert.ok(values.includes('Space: 5 (GB)'))
  assert.ok(values.includes('Standard · versione 1: 470,00')); assert.ok(values.includes('Standard · versione 1: importo non disponibile'))
  assert.equal(JSON.stringify(presentation).includes('null'), false); assert.equal(JSON.stringify(presentation).includes('undefined'), false)
  assert.ok(attachChatPresentation({data: normalizePlanDetail(missing)}).data.presentation.cards[0].details.some(x => x.value === 'Prezzo non disponibile nel catalogo.'))
})
for (const invalid of [{}, {plan: 1}, {plan: 'Unique', supplier: 'Aruba'}, {planId: 'p1'}, {plan: 'Unique', ranking: true}]) {
  test(`F5: strict schema rejects ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => validateToolArguments(tool, invalid), {code: 'TOOL_VALIDATION_ERROR'})
  })
}
test('F5: blank plan fails before any datasource access', async () => {
  await assert.rejects(getRenewalsPlan({plan: ' \t '}, {queryCatalog}), {code: 'TOOL_VALIDATION_ERROR'})
  assert.equal(reads.length, 0)
})
test('F5: principal, credential, capability and read/low policy enforced', () => {
  assertAutomaticToolPolicy(tool, {credentials, principal})
  for (const options of [{credentials: {}, principal}, {credentials}, {credentials, principal: {id: 'operator', source: 'other'}}]) {
    assert.throws(() => assertAutomaticToolPolicy(tool, options), {code: 'TOOL_AUTHORIZATION_DENIED'})
  }
  assert.throws(() => assertAutomaticToolPolicy({...tool, capabilityId: 'unknown'}, {credentials, principal}), {code: 'TOOL_CAPABILITY_DENIED'})
  for (const changed of [{mode: 'write'}, {risk: 'high'}]) assert.throws(() => assertAutomaticToolPolicy({...tool, ...changed}, {credentials, principal}), {code: 'TOOL_POLICY_DENIED'})
})
for (const moduleId of ['facile', 'facile.renewals']) {
  test(`F5: POST ${moduleId} selects terminal native detail without second formatting model/fallback`, async () => {
    const result = await post('quanto costa il piano Unique?', [], moduleId)
    assert.equal(result.ok, true); assert.equal(result.meta.agentOutcome, 'HANDLED'); assert.equal(result.meta.terminalTool, tool.name)
    assert.equal(result.data.id, 'p1'); assert.equal(requests.length, 1); assert.equal(legacy, 0)
    assert.ok(!result.meta.toolErrors?.length); assert.notEqual(result.meta.legacyFallback, true)
  })
}
for (const previous of ['renewals_list_entities', 'renewals_search_plans']) {
  for (const stateMode of ['switch', 'refine']) {
    test(`F5: POST ${previous} → detail without merging previous args (${stateMode})`, async () => {
      choice = previous; args = previous === 'renewals_list_entities' ? {entityType: 'plan', limit: 2, offset: 1} : {supplier: 'Aruba', limit: 2, offset: 1}
      const prior = await post('piani')
      choice = tool.name; args = {plan: 'p1'}; decision = stateMode
      const result = await post('dettagli di Unique', historyFor(prior))
      assert.deepEqual(result.meta.agentState.args, {plan: 'p1'}); assert.equal(result.data.id, 'p1')
      assert.equal(legacy, 0); assert.ok(!result.meta.toolErrors?.length)
    })
  }
}
test('F5: singleton snapshot retains stable plan ID for elliptical detail', async () => {
  rows = [structuredClone(rich)]; choice = 'renewals_search_plans'; args = {supplier: 'Aruba'}
  const prior = await post('piani Aruba')
  assert.equal(prior.meta.agentState.result.items[0].id, 'p1')
  choice = tool.name; args = {plan: prior.meta.agentState.result.items[0].id}; requests = []
  const result = await post('quanto costa?', historyFor(prior))
  assert.equal(result.data.id, 'p1'); assert.ok(requests.some(r => JSON.stringify(r.messages).includes('p1')))
})
for (const [plan,code] of [['Unknown', 'NOT_FOUND'], ['Duplicate', 'AMBIGUOUS']]) {
  test(`F5: POST ${code} returns structured clarification without legacy`, async () => {
    args = {plan}; const result = await post('dettagli piano')
    assert.equal(result.ok, true); assert.equal(result.data.code, code); assert.equal(legacy, 0)
    assert.notEqual(result.meta.legacyFallback, true); assert.ok(!result.meta.toolErrors?.length)
  })
}
for (const invalid of ['{broken', {plan: 'Unique', supplier: 'Aruba'}]) {
  test(`F5: POST invalid args cannot execute or fall back: ${JSON.stringify(invalid)}`, async () => {
    args = invalid; const result = await post('piano')
    assert.equal(result.meta.agentOutcome, 'ERROR'); assert.equal(reads.length, 0); assert.equal(legacy, 0)
  })
}
test('F5: POST execution error and missing CRM are ERROR without fallback', async () => {
  failure = 'execution'; const result = await post('piano Unique')
  assert.equal(result.meta.agentOutcome, 'ERROR'); assert.equal(legacy, 0)
  failure = null; reads = []
  assert.equal((await post('piano Unique', [], 'facile', '')).meta.agentOutcome, 'ERROR')
  assert.equal(reads.length, 0); assert.equal(legacy, 0)
})
test('F5: F1–F4 modules and protected agent/routing/provider files unchanged', () => {
  // F6 authorizes batch execution changes, with model-facing guards in agent-batch.
  for (const path of ['src/modules/facile/renewals/catalogEntities.js', 'src/modules/facile/renewals/planSearch.js',
    'src/routes/chat.js', 'src/core/orchestrator/globalChat.js',
    'src/core/orchestrator/agentOutcome.js', 'src/core/tools/agentState.js', 'src/core/tools/proposalGate.js',
    'src/core/tools/toolContract.js', 'src/core/providers/ollamaProvider.js']) {
    assert.equal(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'), execFileSync('git', ['show', `HEAD:${path}`], {encoding: 'utf8'}))
  }
})
