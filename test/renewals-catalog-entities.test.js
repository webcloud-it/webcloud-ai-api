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
    assert.equal(query.entity, entityType === 'resourceType' ? 'resources' : 'providers'); assert.equal(query.operation, 'list')
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
for (const args of [{}, {entityType: 'plan'}, {entityType: 'supplier', filters: []},
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
        outcome: 'CAPABILITY_NOT_MIGRATED', capabilityIds: ['facile.renewals.read'],
      }}}]}})
  assert.equal(result.outcome, 'CAPABILITY_NOT_MIGRATED')
  assert.equal(result.response.meta.toolCalls.length, 0)
})
test('F1: nessuna modifica al router linguistico o al core agentico', () => {
  for (const path of ['src/routes/chat.js', 'src/core/orchestrator/globalChat.js', 'src/core/orchestrator/globalConversation.js',
    'src/core/orchestrator/agentOutcome.js', 'src/core/tools/agentState.js', 'src/core/tools/proposalGate.js',
    'src/core/tools/toolContract.js', 'src/core/providers/ollamaProvider.js']) {
    assert.deepEqual(readFileSync(new URL(`../${path}`, import.meta.url)), execFileSync('git', ['show', `HEAD:${path}`]))
  }
})

test('F2: resourceType è accettato dallo stesso schema; altre anagrafiche restano escluse', () => {
  assert.deepEqual(tool.definition.function.parameters.properties.entityType.enum, ['supplier', 'resourceType'])
  validateToolArguments(tool, {entityType: 'resourceType', limit: 50, offset: 0})
  for (const entityType of ['plan', 'customer', 'group', 'resources', '__proto__']) {
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
      ['supplier', 'resourceType'])
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
