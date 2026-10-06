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
import {normalizeCatalogEntities, listRenewalsEntities, renewalsListEntitiesTool as tool} from '../src/modules/facile/renewals/catalogEntities.js'
import {attachChatPresentation} from '../src/core/presentation/chatPresentation.js'
import {executeAgentRequest} from '../src/core/orchestrator/globalConversation.js'

const principal = {id: 'operator', source: 'crm'}, credentials = {crm: 'fixture'}
const rows = [{id: 'b', name: ' Webcloud '}, {id: 'a', name: 'Aruba'},
  {id: 'b', name: 'Webcloud'}, {name: '  WEBcloud '}, {name: ' Register.it '},
  {name: 'register.it'}, {id: 'c', label: 'Zeta'}, {name: null}, null]
const resourceRows = Array.from({length: 15}, (_, index) => ({id: `r${index}`,
  name: `Risorsa ${String(index).padStart(2, '0')}`, key: `key${index}`,
  ...(index % 3 ? {category: 'hosting'} : {category: null}),
  ...(index % 4 ? {unitOfMeasurement: 'GB'} : {unitOfMeasurement: null}),
})).reverse()
const planRows = Array.from({length: 199}, (_, index) => ({id: `p${String(index).padStart(3, '0')}`,
  name: `Piano ${String(index).padStart(3, '0')}`, type: '1', kind: 'base', isAddon: false,
  supplier: index % 3 ? {id: 's1', name: ' Fornitore ', internal: 'excluded'} : null,
  resources: [{name: 'Spazio', amount: '10', unitOfMeasurement: 'GB'}],
  resourceNames: ['Spazio'], priceEntries: [{price: 100, priceListVersion: {name: 'Privato'}}],
  prices: [100], priceListVersionNames: ['Privato'], description: 'excluded', duration: 12,
})).reverse()
let model, datasource, appServer, url, requests, reads, legacy, mode, fixtureRows, entityType
const originalEnv = {ollamaBaseUrl: env.ollamaBaseUrl, renewalsApiBaseUrl: env.renewalsApiBaseUrl, crmToken: env.crmToken}
const module = getModuleById('facile.renewals'), originalRoutes = module.routes
const argumentsForMode = () => mode === 'extra' ? {entityType, filter: 'arbitrary'}
  : mode === 'invalid' ? {entityType: 'invented'} : mode === 'missing' ? {}
    : mode === 'json' ? '{broken' : {entityType}

before(async () => {
  datasource = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const query = JSON.parse(raw); reads.push(query)
    res.setHeader('Content-Type', 'application/json')
    // Error responses must not leave a pooled fixture socket for the next test.
    res.setHeader('Connection', 'close')
    if (mode === 'execution') {res.statusCode = 500; return res.end(JSON.stringify({error: 'PRIVATE_DATASOURCE'}))}
    assert.equal(req.url, '/catalog/query')
    assert.equal(query.entity, {supplier: 'providers', resourceType: 'resources', plan: 'plans'}[entityType]); assert.equal(query.operation, 'list')
    assert.deepEqual(query.filters, [])
    assert.deepEqual(query.sort, [{field: 'name', direction: 'asc'}, {field: 'id', direction: 'asc'}])
    assert.equal(query.limit, 50)
    const items = fixtureRows.slice(query.offset, query.offset + query.limit)
    res.end(JSON.stringify({ok: true, source: 'catalog', sourceScope: 'complete-master-data',
      entity: query.entity, total: fixtureRows.length, items, offset: query.offset,
      nextOffset: query.offset + items.length, hasMore: query.offset + items.length < fixtureRows.length}))
  })
  datasource.listen(0, '127.0.0.1'); await once(datasource, 'listening')
  env.renewalsApiBaseUrl = `http://127.0.0.1:${datasource.address().port}`; env.crmToken = 'fixture'
  model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const request = JSON.parse(raw); requests.push(request)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({message: {role: 'assistant', content: '', tool_calls: [{function: {
      name: tool.name, arguments: argumentsForMode(),
    }}]}}))
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  env.ollamaBaseUrl = `http://127.0.0.1:${model.address().port}`
  module.routes = {...module.routes, chat: async (_req, res) => {legacy++; res.json({ok: true, reply: 'legacy'})}}
  const app = express(); app.use(express.json())
  app.use(createAuthTokenMiddleware({validateCrmToken: async () => principal}))
  app.use('/api/chat', chatRouter)
  appServer = app.listen(0, '127.0.0.1'); await once(appServer, 'listening')
  url = `http://127.0.0.1:${appServer.address().port}`
})
beforeEach(() => {requests = []; reads = []; legacy = 0; mode = 'valid'; fixtureRows = rows; entityType = 'supplier'})
after(async () => {
  Object.assign(env, originalEnv); module.routes = originalRoutes
  for (const server of [model, datasource, appServer]) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve))}
})
async function post(message, moduleId = 'facile', crm = 'fixture') {
  const response = await fetch(`${url}/api/chat`, {method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: 'Bearer fixture', 'X-Webcloud-Credential-Crm': crm,
  }, body: JSON.stringify({moduleId, message})})
  assert.equal(response.status, 200)
  return response.json()
}

test('F1: normalizzazione deduplica ID e nomi senza perdere id/name', () => {
  const result = normalizeCatalogEntities(rows)
  assert.deepEqual(result, [{id: 'a', name: 'Aruba'}, {name: 'register.it'},
    {id: 'b', name: 'Webcloud'}, {id: 'c', name: 'Zeta'}])
  assert.ok(result.every(item => Object.values(item).every(value => typeof value === 'string' && value)))
})
test('F1: ordinamento e scelta label indipendenti dall’ordine datasource', () => {
  for (const variant of [rows.toReversed(), [...rows.slice(3), ...rows.slice(0, 3)]]) {
    assert.deepEqual(normalizeCatalogEntities(variant), normalizeCatalogEntities(rows))
  }
})
test('F1: ID distinti con stesso nome restano distinti; ID zero è valido', () => {
  assert.deepEqual(normalizeCatalogEntities([{id: 'b', name: 'Nome'}, {id: 'a', name: ' nome '},
    {id: 0}, {name: ' Nome '}, {id: 'x', name: '  Due   parole  '}]),
  [{id: '0', name: '0'}, {id: 'x', name: 'Due parole'}, {id: 'a', name: 'nome'}, {name: 'Nome'}, {id: 'b', name: 'Nome'}])
})
test('F1: nomi con spazi/maiuscole senza ID sono la stessa entità', () => {
  assert.deepEqual(normalizeCatalogEntities([{name: ' Register.it '}, {name: 'register.it'},
    {name: '  Due   parole  '}, {name: 'due parole'}]), [{name: 'due parole'}, {name: 'register.it'}])
})
test('F1: catalogo paginato viene normalizzato prima della paginazione pubblica', async () => {
  fixtureRows = [...Array.from({length: 55}, (_, i) => ({id: `id${i}`, name: `Fornitore ${String(i).padStart(2, '0')}`})),
    {id: 'id1', name: 'Fornitore 01'}, {name: ' FORNITORE 01 '}]
  const data = await listRenewalsEntities({entityType: 'supplier', limit: 10, offset: 50})
  assert.equal(reads.length, 2); assert.equal(reads[1].offset, 50)
  assert.equal(data.sourceTotal, 57); assert.equal(data.total, 55); assert.equal(data.shown, 5)
  assert.equal(data.items[0].id, 'id50'); assert.equal(data.hasMore, false); assert.equal(data.nextOffset, null)
})
test('F1: catalogo vuoto e offset oltre la lista non inventano entità', async () => {
  fixtureRows = []
  assert.equal((await listRenewalsEntities({entityType: 'supplier'})).total, 0)
  fixtureRows = rows
  const data = await listRenewalsEntities({entityType: 'supplier', limit: 1, offset: 100})
  assert.equal(data.total, 4); assert.deepEqual(data.items, []); assert.equal(data.hasMore, false)
})
for (const invalid of [null, {ok: false}, {ok: true, source: 'catalog', sourceScope: 'complete-master-data', entity: 'providers',
  offset: 0, total: 1, hasMore: false, items: []}, {ok: true, source: 'catalog', sourceScope: 'complete-master-data', entity: 'providers',
  offset: 0, total: 2, nextOffset: 0, hasMore: true, items: [{id: 'a', name: 'A'}]}]) {
  test(`F1: datasource incompleto/invalido non è un successo (${JSON.stringify(invalid)})`, async () => {
    await assert.rejects(listRenewalsEntities({entityType: 'supplier'}, {queryCatalog: async () => invalid}))
  })
}
for (const args of [{}, {entityType: 'invented'}, {entityType: 'supplier', filters: []},
  {entityType: 'supplier', limit: 51}, {entityType: 'supplier', limit: 0},
  {entityType: 'supplier', offset: -1}, {entityType: 'supplier', limit: '10'}]) {
  test(`F1: schema stretto rifiuta ${JSON.stringify(args)}`, () => {
    assert.throws(() => validateToolArguments(tool, args), error => error.code === 'TOOL_VALIDATION_ERROR')
  })
}
test('F1: read/low, capability, principal e credenziale Step A', () => {
  assert.equal(tool.mode, 'read'); assert.equal(tool.risk, 'low'); assert.equal(tool.requiresPrincipal, true)
  assert.equal(tool.capabilityId, 'facile.renewals.read')
  assertAutomaticToolPolicy(tool, {credentials, principal})
  for (const options of [{credentials: {}, principal}, {credentials}, {credentials, principal: {id: 'operator', source: 'other'}}]) {
    assert.throws(() => assertAutomaticToolPolicy(tool, options), error => error.code === 'TOOL_AUTHORIZATION_DENIED')
  }
  assert.ok(getRegisteredTools({credentials}).some(item => item.name === tool.name))
})
for (const moduleId of ['facile', 'facile.renewals']) {
  test(`F1: POST ${moduleId} lista fornitori nativa, zero servizi/legacy`, async () => {
    const result = await post('lista dei fornitori presenti', moduleId)
    assert.equal(result.meta.terminalTool, tool.name); assert.equal(result.meta.agentOutcome, 'HANDLED')
    assert.equal(result.ok, true); assert.equal(result.data.total, 4)
    assert.deepEqual(result.data.items, normalizeCatalogEntities(rows))
    assert.equal(legacy, 0); assert.notEqual(result.meta.legacyFallback, true)
    assert.ok(!result.meta.toolErrors?.length)
    assert.deepEqual(result.meta.toolCalls.map(item => item.name), [tool.name])
    assert.ok(requests[0].tools.some(item => item.function.name === tool.name))
    assert.equal(reads.length, 1)
    assert.equal(result.data.presentation.title, 'Fornitori trovati: 4')
    assert.deepEqual(result.data.presentation.cards.map(item => item.title), ['Aruba', 'register.it', 'Webcloud', 'Zeta'])
  })
}
for (const failure of ['invalid', 'extra', 'missing', 'json', 'execution']) {
  test(`F1: ${failure} bloccato senza fallback legacy`, async () => {
    mode = failure
    const result = await post('lista fornitori')
    assert.equal(result.ok, false); assert.equal(result.meta.agentOutcome, 'ERROR')
    assert.ok(result.meta.toolErrors.length); assert.equal(legacy, 0)
    if (failure !== 'execution') assert.equal(reads.length, 0)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DATASOURCE/)
  })
}
test('F1: richiesta senza CRM non esegue il datasource', async () => {
  const result = await post('fornitori', 'facile', '')
  assert.equal(result.meta.agentOutcome, 'ERROR'); assert.equal(reads.length, 0); assert.equal(legacy, 0)
})
test('F1: presentation generica conserva tutti i risultati mostrati e omette ID assenti', () => {
  const result = attachChatPresentation({data: {type: 'renewals-entity-list', entityType: 'supplier',
    entityLabel: 'Fornitori', total: 18, offset: 0, items: Array.from({length: 18}, (_, i) => ({name: `Nome ${i}`}))}})
  assert.equal(result.data.presentation.kind, 'list'); assert.equal(result.data.presentation.cards.length, 18)
  assert.ok(result.data.presentation.cards.every(item => item.title && item.id && Object.keys(item).length === 2))
})
test('F1: snapshot descrive lista, non contiene conteggi servizi; follow-up non migrato è esplicito', async () => {
  const first = await post('fornitori')
  assert.equal(first.meta.agentState.stateful, false)
  assert.equal(first.meta.agentState.result.total, 4)
  assert.equal(first.meta.agentState.result.items, undefined)
  assert.equal(first.meta.agentState.result.serviceCount, undefined)
  const result = await executeAgentRequest({message: 'quali hanno più servizi?', credentials, principal,
    history: [{role: 'assistant', content: first.reply, meta: first.meta}], callModel: async request => request.format
      ? {content: JSON.stringify({stateMode: 'switch', entityReference: ''})}
      : {tool_calls: [{function: {name: 'agent_report_outcome', arguments: {
        outcome: 'CAPABILITY_NOT_MIGRATED', legacyAreas: ['Rinnovi e CRM'],
      }}}]}})
  assert.equal(result.outcome, 'CAPABILITY_NOT_MIGRATED')
  assert.equal(result.response.meta.toolCalls.length, 0)
})
test('F1: router e contratti agentici protetti restano invariati', () => {
  // F6 batch execution and F7 control projection/adapter selection have dedicated
  // guards; business contracts, state, proposal policy and providers stay fixed.
  for (const path of ['src/core/orchestrator/globalChat.js',
    'src/core/tools/agentState.js', 'src/core/tools/proposalGate.js',
    'src/core/tools/toolContract.js', 'src/core/providers/ollamaProvider.js']) {
    assert.deepEqual(readFileSync(new URL(`../${path}`, import.meta.url)), execFileSync('git', ['show', `HEAD:${path}`]))
  }
})

test('F2: resourceType è accettato dallo stesso schema; altre anagrafiche restano escluse', () => {
  assert.deepEqual(tool.definition.function.parameters.properties.entityType.enum, ['supplier', 'resourceType', 'plan'])
  validateToolArguments(tool, {entityType: 'resourceType', limit: 50, offset: 0})
  for (const entityType of ['addon', 'customer', 'group', 'resources', '__proto__']) {
    assert.throws(() => validateToolArguments(tool, {entityType}), error => error.code === 'TOOL_VALIDATION_ERROR')
  }
})
test('F2: supplier conserva esattamente id/name anche se il datasource ha altri campi', () => {
  assert.deepEqual(normalizeCatalogEntities([{id: 's', name: 'Nome', category: 'hosting', unitOfMeasurement: 'GB'}]),
    [{id: 's', name: 'Nome'}])
  const payload = {data: {type: 'renewals-entity-list', entityType: 'supplier', entityLabel: 'Fornitori',
    total: 1, offset: 0, items: [{id: 's', name: 'Nome'}]}}
  assert.deepEqual(attachChatPresentation(payload).data.presentation, {
    version: 1, kind: 'list', title: 'Fornitori trovati: 1', total: 1, cards: [{id: 's', title: 'Nome'}],
  })
})
test('F2: resourceType normalizza 15 entità, categoria/unità opzionali e ignora key', async () => {
  entityType = 'resourceType'; fixtureRows = resourceRows
  const data = await listRenewalsEntities({entityType})
  assert.equal(data.total, 15); assert.equal(data.entityLabel, 'Tipi di risorsa')
  assert.deepEqual(data.items.map(item => item.id), Array.from({length: 15}, (_, i) => `r${i}`))
  assert.deepEqual(data.items[0], {id: 'r0', name: 'Risorsa 00'})
  assert.deepEqual(data.items[1], {id: 'r1', name: 'Risorsa 01', category: 'hosting', unit: 'GB'})
  assert.deepEqual(data.items[3], {id: 'r3', name: 'Risorsa 03', unit: 'GB'})
  assert.deepEqual(data.items[4], {id: 'r4', name: 'Risorsa 04', category: 'hosting'})
  assert.ok(data.items.every(item => Object.values(item).every(value => typeof value === 'string' && value)))
  assert.equal(reads[0].entity, 'resources')
})
test('F2: deduplica risorse per ID/nome con metadata deterministici e ordine stabile', () => {
  const input = [{id: 'r', name: ' Zeta ', category: ' hosting ', unitOfMeasurement: null},
    {id: 'r', name: 'Zeta', unitOfMeasurement: ' GB '},
    {name: '  zeta ', category: 'hosting', unitOfMeasurement: 'GB'},
    {name: ' Alfa ', category: 'mail'}, {name: 'alfa', unitOfMeasurement: 'caselle'}]
  const expected = [{name: 'alfa', category: 'mail', unit: 'caselle'},
    {id: 'r', name: 'Zeta', category: 'hosting', unit: 'GB'}]
  assert.deepEqual(normalizeCatalogEntities(input, 'resourceType'), expected)
  assert.deepEqual(normalizeCatalogEntities(input.toReversed(), 'resourceType'), expected)
})
test('F2: metadata risorse contraddittori restano valori reali scelti deterministicamente', () => {
  const input = [{id: 'r', name: 'Nome', category: 'mail', unitOfMeasurement: 'MB'},
    {id: 'r', name: 'Nome', category: 'hosting', unitOfMeasurement: 'GB'}]
  const result = normalizeCatalogEntities(input, 'resourceType')
  assert.deepEqual(result, [{id: 'r', name: 'Nome', category: 'hosting', unit: 'GB'}])
  assert.deepEqual(result, normalizeCatalogEntities(input.toReversed(), 'resourceType'))
})
test('F2: metadata null, vuoti o non testuali non diventano dettagli', () => {
  assert.deepEqual(normalizeCatalogEntities([{id: 'r', name: 'Nome', category: ' ', unitOfMeasurement: null},
    {id: 'r2', name: 'Secondo', category: {}, unitOfMeasurement: 12}], 'resourceType'),
  [{id: 'r', name: 'Nome'}, {id: 'r2', name: 'Secondo'}])
})
test('F2: metadata presenti solo sulla riga senza ID non vengono persi nel merge', () => {
  assert.deepEqual(normalizeCatalogEntities([{id: 'r', name: 'Nome'},
    {name: ' nome ', category: 'mail', unitOfMeasurement: 'caselle'}], 'resourceType'),
  [{id: 'r', name: 'Nome', category: 'mail', unit: 'caselle'}])
})
test('F2: paginazione pubblica risorse dopo lettura completa e deduplica', async () => {
  entityType = 'resourceType'; fixtureRows = [...resourceRows, {...resourceRows[0]}]
  const data = await listRenewalsEntities({entityType, limit: 5, offset: 5})
  assert.equal(data.total, 15); assert.equal(data.sourceTotal, 16); assert.equal(data.shown, 5)
  assert.equal(data.items[0].id, 'r5'); assert.equal(data.hasMore, true); assert.equal(data.nextOffset, 10)
})
test('F2: tutte le pagine datasource resources sono lette prima di dichiarare il totale', async () => {
  entityType = 'resourceType'
  fixtureRows = Array.from({length: 55}, (_, i) => ({id: `r${i}`, name: `Risorsa ${String(i).padStart(2, '0')}`}))
  const data = await listRenewalsEntities({entityType, limit: 5, offset: 50})
  assert.equal(reads.length, 2); assert.equal(reads[1].offset, 50)
  assert.equal(data.total, 55); assert.equal(data.shown, 5); assert.equal(data.hasMore, false)
})
test('F2: catalogue incompleto o entità datasource sbagliata non restituisce risultati risorse', async () => {
  for (const result of [{ok: true, source: 'catalog', sourceScope: 'complete-master-data', entity: 'resources',
    offset: 0, total: 15, items: resourceRows.slice(0, 2), hasMore: false},
  {ok: true, source: 'catalog', sourceScope: 'complete-master-data', entity: 'providers',
    offset: 0, total: 15, items: resourceRows, hasMore: false}]) {
    await assert.rejects(listRenewalsEntities({entityType: 'resourceType'}, {queryCatalog: async () => result}))
  }
})
test('F2: presentation risorse include solo categoria/unità realmente disponibili', () => {
  const presentation = attachChatPresentation({data: {type: 'renewals-entity-list', entityType: 'resourceType',
    entityLabel: 'Tipi di risorsa', total: 3, offset: 0, items: [
      {id: 'r1', name: 'Spazio', category: 'hosting', unit: 'GB'},
      {id: 'r2', name: 'Risorsa', category: null, unit: undefined},
      {id: 'r3', name: 'Caselle', category: 'mail'},
    ]}}).data.presentation
  assert.equal(presentation.title, 'Tipi di risorsa trovati: 3')
  assert.deepEqual(presentation.cards[0].details, [{label: 'Categoria', value: 'hosting'}, {label: 'Unità', value: 'GB'}])
  assert.deepEqual(presentation.cards[1], {id: 'r2', title: 'Risorsa'})
  assert.deepEqual(presentation.cards[2].details, [{label: 'Categoria', value: 'mail'}])
  assert.doesNotMatch(JSON.stringify(presentation), /null|undefined/)
})
for (const moduleId of ['facile', 'facile.renewals']) {
  test(`F2: POST ${moduleId} sceglie stesso tool con resourceType, zero servizi/legacy`, async () => {
    entityType = 'resourceType'; fixtureRows = resourceRows
    const result = await post('richiesta gestita dal modello', moduleId)
    assert.equal(result.ok, true); assert.equal(result.meta.agentOutcome, 'HANDLED')
    assert.equal(result.meta.terminalTool, tool.name); assert.equal(result.data.entityType, 'resourceType')
    assert.equal(result.data.total, 15); assert.equal(result.data.presentation.cards.length, 15)
    assert.equal(result.meta.agentState.args.entityType, 'resourceType')
    assert.deepEqual(result.meta.toolCalls.map(item => item.name), [tool.name])
    assert.ok(!result.meta.toolErrors?.length); assert.notEqual(result.meta.legacyFallback, true)
    assert.equal(legacy, 0); assert.equal(reads[0].entity, 'resources')
    assert.deepEqual(requests[0].tools.find(item => item.function.name === tool.name).function.parameters.properties.entityType.enum,
      ['supplier', 'resourceType', 'plan'])
  })
}
for (const failure of ['extra', 'invalid', 'execution']) {
  test(`F2: ${failure} per risorse è ERROR, senza fallback`, async () => {
    entityType = 'resourceType'; fixtureRows = resourceRows; mode = failure
    const result = await post('risorse')
    assert.equal(result.ok, false); assert.equal(result.meta.agentOutcome, 'ERROR'); assert.equal(legacy, 0)
    if (failure !== 'execution') assert.equal(reads.length, 0)
    assert.ok(result.meta.toolErrors.length)
  })
}
test('F2: resourceType mantiene credential/principal/capability e non permette write/high', async () => {
  entityType = 'resourceType'; fixtureRows = resourceRows
  assert.throws(() => assertAutomaticToolPolicy({...tool, risk: 'high'}, {credentials, principal}))
  assert.throws(() => assertAutomaticToolPolicy({...tool, mode: 'write'}, {credentials, principal}))
  const result = await post('risorse', 'facile', '')
  assert.equal(result.meta.agentOutcome, 'ERROR'); assert.equal(reads.length, 0)
  assert.equal(tool.capabilityId, 'facile.renewals.read')
})
test('F2: stesso tool già registrato, con il contratto esteso e limiti generici', () => {
  const registered = getRegisteredTools({credentials}).filter(item => item.name === tool.name)
  assert.equal(registered.length, 1)
  assert.deepEqual(registered[0].definition, tool.definition)
  assert.match(tool.definition.function.description, /ranking/)
  assert.match(tool.definition.function.description, /aggregazioni o join/)
})

test('F3: plan accettato nello stesso schema stretto, senza filtri aggiuntivi', () => {
  validateToolArguments(tool, {entityType: 'plan', limit: 1, offset: 0})
  validateToolArguments(tool, {entityType: 'plan', limit: 50, offset: 100})
  for (const args of [{entityType: 'addon'}, {entityType: 'unknown'},
    {entityType: 'plan', supplier: 'Fornitore'}, {entityType: 'plan', resource: 'mail'},
    {entityType: 'plan', price: 100}, {entityType: 'plan', limit: 0},
    {entityType: 'plan', limit: 51}, {entityType: 'plan', limit: 1.5}, {entityType: 'plan', offset: -1}]) {
    assert.throws(() => validateToolArguments(tool, args), error => error.code === 'TOOL_VALIDATION_ERROR')
  }
})
test('F3: 199 piani base, quattro pagine backend e pagina pubblica di 50', async () => {
  entityType = 'plan'; fixtureRows = planRows
  const data = await listRenewalsEntities({entityType})
  assert.equal(data.total, 199); assert.equal(data.sourceTotal, 199); assert.equal(data.shown, 50)
  assert.equal(data.entityLabel, 'Piani base'); assert.equal(data.limit, 50); assert.equal(data.offset, 0)
  assert.equal(data.hasMore, true); assert.equal(data.nextOffset, 50)
  assert.deepEqual(reads.map(x => x.offset), [0, 50, 100, 150])
  assert.ok(reads.every(x => x.entity === 'plans' && x.filters.length === 0))
  assert.equal(data.items[0].id, 'p000'); assert.equal(data.items[49].id, 'p049')
})
test('F3: stessa entità per ID, ID distinti con lo stesso nome preservati', () => {
  const input = [{id: 'p2', name: 'Uguale', supplier: {id: 's2', name: 'Altro'}},
    {id: 'p1', name: 'Uguale', supplier: {id: 's1', name: 'Fornitore'}},
    {id: 'p2', name: ' Uguale ', supplier: {id: 's2', name: ' Altro '}}]
  const expected = [{id: 'p1', name: 'Uguale', supplier: {id: 's1', name: 'Fornitore'}},
    {id: 'p2', name: 'Uguale', supplier: {id: 's2', name: 'Altro'}}]
  assert.deepEqual(normalizeCatalogEntities(input, 'plan'), expected)
  assert.deepEqual(normalizeCatalogEntities(input.toReversed(), 'plan'), expected)
})
test('F3: ordinamento italiano e supplier ridotto a un riferimento verificato', () => {
  assert.deepEqual(normalizeCatalogEntities([
    {id: 'z', name: ' Zeta ', supplier: {id: ' s1 ', name: ' Due   parole ', prices: [100]}},
    {id: 'a', name: 'Alfa', supplier: {name: 'Solo nome', extra: true}},
  ], 'plan'), [{id: 'a', name: 'Alfa', supplier: {name: 'Solo nome'}},
    {id: 'z', name: 'Zeta', supplier: {id: 's1', name: 'Due parole'}}])
})
test('F3: fornitore assente o senza nome non inventato e senza null', () => {
  for (const supplier of [null, undefined, {}, {id: 's'}, {name: ' '}, {name: {}}]) {
    assert.deepEqual(normalizeCatalogEntities([{id: 'p', name: 'Piano', supplier}], 'plan'), [{id: 'p', name: 'Piano'}])
  }
})
test('F3: duplicati con fornitori discordanti preservano una coppia ID/nome reale', () => {
  const input = [{id: 'p', name: 'Piano', supplier: {id: 's2', name: 'Alfa'}},
    {id: 'p', name: 'Piano', supplier: {id: 's1', name: 'Zeta'}},
    {id: 'p', name: 'Piano', supplier: {name: 'A senza ID'}}]
  const result = [{id: 'p', name: 'Piano', supplier: {id: 's1', name: 'Zeta'}}]
  assert.deepEqual(normalizeCatalogEntities(input, 'plan'), result)
  assert.deepEqual(normalizeCatalogEntities(input.toReversed(), 'plan'), result)
})
test('F3: ultimo tratto e offset oltre i piani dopo normalizzazione completa', async () => {
  entityType = 'plan'; fixtureRows = [...planRows, {...planRows[0]}]
  const data = await listRenewalsEntities({entityType, limit: 50, offset: 150})
  assert.equal(data.total, 199); assert.equal(data.sourceTotal, 200); assert.equal(data.shown, 49)
  assert.equal(data.items[0].id, 'p150'); assert.equal(data.items[48].id, 'p198')
  assert.equal(data.hasMore, false); assert.equal(data.nextOffset, null)
  assert.deepEqual((await listRenewalsEntities({entityType, limit: 1, offset: 199})).items, [])
})
test('F3: pagina plans incompleta o errata fallisce esplicitamente', async () => {
  for (const result of [{ok: true, source: 'catalog', sourceScope: 'complete-master-data', entity: 'plans',
    offset: 0, total: 199, items: planRows.slice(0, 50), hasMore: false},
  {ok: true, source: 'catalog', sourceScope: 'complete-master-data', entity: 'addons',
    offset: 0, total: 1, items: planRows.slice(0, 1), hasMore: false}]) {
    await assert.rejects(listRenewalsEntities({entityType: 'plan'}, {queryCatalog: async () => result}))
  }
})
test('F3: modelContent contiene solo 50 proiezioni compatte, nessun prezzo/risorsa/listino', async () => {
  entityType = 'plan'; fixtureRows = planRows
  const result = await tool.execute({entityType})
  assert.equal(result.modelContent.items.length, 50); assert.equal(result.modelContent.total, 199)
  assert.deepEqual(result.modelContent.items[0], {id: 'p000', name: 'Piano 000'})
  assert.deepEqual(result.modelContent.items[1], {id: 'p001', name: 'Piano 001', supplier: {id: 's1', name: 'Fornitore'}})
  assert.ok(result.modelContent.items.every(x => Object.keys(x).every(key => ['id', 'name', 'supplier'].includes(key))))
  assert.doesNotMatch(JSON.stringify(result.modelContent), /price|resources|duration|description|Privato|excluded/)
  assert.match(result.reply, /^Piani base trovati: 199\./)
  assert.match(result.reply, /Mostro 50 risultati dalla posizione 1\./)
  assert.match(result.reply, /Piano 001 · Fornitore/)
})
test('F3: presentation piani con fornitore opzionale e senza metadata pesanti', () => {
  const presentation = attachChatPresentation({data: {type: 'renewals-entity-list', entityType: 'plan',
    entityLabel: 'Piani base', total: 199, offset: 0, items: [
      {id: 'p1', name: 'Piano', supplier: {id: 's1', name: 'Fornitore'}},
      {id: 'p2', name: 'Senza fornitore'},
    ]}}).data.presentation
  assert.equal(presentation.title, 'Piani base trovati: 199')
  assert.deepEqual(presentation.cards, [{id: 'p1', title: 'Piano', details: [{label: 'Fornitore', value: 'Fornitore'}]},
    {id: 'p2', title: 'Senza fornitore'}])
})
for (const moduleId of ['facile', 'facile.renewals']) {
  test(`F3: POST ${moduleId} seleziona lo stesso tool plan senza servizi/fallback`, async () => {
    entityType = 'plan'; fixtureRows = planRows
    const result = await post('richiesta scelta dal modello', moduleId)
    assert.equal(result.ok, true); assert.equal(result.meta.agentOutcome, 'HANDLED')
    assert.equal(result.meta.terminalTool, tool.name); assert.equal(result.data.entityType, 'plan')
    assert.equal(result.data.total, 199); assert.equal(result.data.shown, 50)
    assert.equal(result.meta.agentState.args.entityType, 'plan')
    assert.deepEqual(result.meta.toolCalls.map(x => x.name), [tool.name])
    assert.ok(!result.meta.toolErrors?.length); assert.notEqual(result.meta.legacyFallback, true); assert.equal(legacy, 0)
    assert.equal(reads.length, 4); assert.equal(result.data.presentation.cards.length, 50)
  })
}
for (const failure of ['extra', 'json', 'execution']) {
  test(`F3: ${failure} per plan bloccato senza fallback`, async () => {
    entityType = 'plan'; fixtureRows = planRows; mode = failure
    const result = await post('piani')
    assert.equal(result.ok, false); assert.equal(result.meta.agentOutcome, 'ERROR'); assert.equal(legacy, 0)
    if (failure !== 'execution') assert.equal(reads.length, 0)
    assert.ok(result.meta.toolErrors.length)
  })
}
test('F3: Step A policy read/low, principal, CRM e capability invariati', async () => {
  entityType = 'plan'; fixtureRows = planRows
  assertAutomaticToolPolicy(tool, {credentials, principal})
  for (const options of [{credentials: {}, principal}, {credentials}, {credentials, principal: {id: 'operator', source: 'other'}}]) {
    assert.throws(() => assertAutomaticToolPolicy(tool, options), error => error.code === 'TOOL_AUTHORIZATION_DENIED')
  }
  assert.throws(() => assertAutomaticToolPolicy({...tool, mode: 'write'}, {credentials, principal}))
  assert.throws(() => assertAutomaticToolPolicy({...tool, risk: 'high'}, {credentials, principal}))
  const result = await post('piani', 'facile', '')
  assert.equal(result.meta.agentOutcome, 'ERROR'); assert.equal(reads.length, 0)
})
