import assert from 'node:assert/strict'
import {after, before, beforeEach, test} from 'node:test'
import {once} from 'node:events'
import http from 'node:http'
import express from 'express'
import chatRouter from '../src/routes/chat.js'
import {createAuthTokenMiddleware} from '../src/middlewares/authToken.js'
import {getModuleById} from '../src/modules/registry.js'
import {env} from '../src/config/env.js'
import {executeAgentRequest} from '../src/core/orchestrator/globalConversation.js'
import {AGENT_CONTROL} from '../src/core/orchestrator/agentOutcome.js'
import {getChatAuditEntries} from '../src/core/observability/chatAudit.js'

const principal = {id: 'operator', source: 'crm'}
const credentials = {crm: 'crm', webcamgo: 'camera'}
const renewals = getModuleById('facile.renewals')
const camera = getModuleById('facile.webcamgo')
const tools = renewals.tools
const savedTools = tools.map(tool => ({...tool}))
const savedRoutes = [renewals.routes, camera.routes]
const baseUrlBefore = env.ollamaBaseUrl
const S = 'renewals_search_services', C = 'renewals_search_communications'
const call = (name, args = {}) => ({role: 'assistant', content: '', tool_calls: [{function: {name,
  arguments: name === AGENT_CONTROL && !args.outcome ? {outcome: 'CAPABILITY_NOT_MIGRATED', ...args} : args}}]})
let model, server, url, mode, requests, executions, legacy, decision

async function post(message, moduleId = 'facile', history = [], extra = {}, headers = {}) {
  const response = await fetch(`${url}/api/chat`, {method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: 'Bearer session',
    'X-Webcloud-Credential-Crm': 'crm', 'X-Webcloud-Credential-Webcamgo': 'camera', ...headers,
  }, body: JSON.stringify({moduleId, message, history, ...extra})})
  return {status: response.status, result: await response.json()}
}
function fixtureReply(request) {
  if (request.format) return {content: JSON.stringify(decision)}
  if (mode === 'general') return call(AGENT_CONTROL, {outcome: 'GENERAL_CONVERSATION', reply: 'Un record MX indica il server che riceve la posta.'})
  if (mode === 'unstructured') return {content: 'Non posso accedere a quei dati.'}
  if (mode === 'legacy') return call(AGENT_CONTROL, {capabilityIds: ['facile.webcamgo.read']})
  if (mode === 'multi') return call(AGENT_CONTROL, {capabilityIds: ['facile.webcamgo.read', 'facile.renewals.read']})
  if (mode === 'bad-control') return call(AGENT_CONTROL, {capabilityIds: ['invented']})
  if (mode === 'scope-control') return call(AGENT_CONTROL, {capabilityIds: ['facile.webcamgo.read']})
  if (mode === 'mixed') return {tool_calls: [...call(S).tool_calls, ...call(AGENT_CONTROL, {capabilityIds: ['facile.webcamgo.read']}).tool_calls]}
  if (mode === 'terminal-batch') return {tool_calls: [
    ...call('renewals_get_plan', {plan: 'DomAssLicBase'}).tool_calls,
    ...call('renewals_get_plan', {plan: 'Aruba-pecprem'}).tool_calls,
  ]}
  if (mode === 'terminal-batch-invalid') return {tool_calls: [
    ...call('renewals_get_plan', {plan: 'DomAssLicBase'}).tool_calls, ...call(C, {latest: 'yes'}).tool_calls,
  ]}
  if (mode === 'nonterminal-batch-failure') return {tool_calls: [...call(S).tool_calls, ...call(C).tool_calls]}
  if (mode === 'error-then-legacy' && requests.filter(item => !item.format).length > 1) return call(AGENT_CONTROL, {capabilityIds: ['facile.webcamgo.read']})
  if (mode === 'empty') return {content: ''}
  if (mode === 'validation' || mode === 'max' || mode === 'error-then-legacy') return call(S, {limit: 0})
  if (mode === 'json') return call(S, '{invalid')
  if (mode === 'mock') return call('third_registered_tool', {})
  if (mode === 'communications') return call(C, {latest: true})
  const content = request.messages.at(-1)?.content
  return call(S, content === 'year' ? {expiresYear: 2026}
    : content === 'exclude' ? {dontRenewMode: 'exclude'}
      : content === 'independent' ? {expiresYear: 2027} : {customerOrGroup: 'Zilio Group'})
}

before(async () => {
  model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const request = JSON.parse(raw); requests.push(request)
    res.setHeader('Content-Type', 'application/json')
    if (mode === 'provider') {res.statusCode = 500; return res.end('PRIVATE_PROVIDER')}
    res.end(JSON.stringify({message: fixtureReply(request)}))
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  env.ollamaBaseUrl = `http://127.0.0.1:${model.address().port}`
  const handler = moduleId => async (_req, res) => {
    legacy.push(moduleId)
    res.json({ok: true, reply: 'Legacy verificato.', data: {type: 'fixture', total: 2}, meta: {moduleId}})
  }
  renewals.routes = {...renewals.routes, chat: handler(renewals.id)}
  camera.routes = {...camera.routes, chat: handler(camera.id)}
  const app = express(); app.use(express.json())
  app.use(createAuthTokenMiddleware({validateCrmToken: async token => token === 'bad' ? null : principal}))
  app.use('/api/chat', chatRouter)
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  url = `http://127.0.0.1:${server.address().port}`
})
beforeEach(() => {
  mode = 'services'; requests = []; executions = []; legacy = []
  decision = {stateMode: 'refine', entityReference: ''}
  tools.splice(0, tools.length, ...savedTools.map(tool => ({...tool, execute: async args => {
    executions.push({name: tool.name, args})
    const communications = tool.name === C
    return {ok: true, reply: 'Risultato verificato.', moduleId: tool.moduleId,
      data: communications ? {type: 'renewals-communications', total: 380, shown: 1,
        items: [{to: 'fixture@example.test', subject: 'Rinnovo', sentAutomatically: false}]}
        : {type: 'service-list', totale: args.dontRenewMode === 'exclude' ? 24 : args.expiresYear ? 27 : 83, items: []}}
  }})))
  delete camera.tools
})
after(async () => {
  tools.splice(0, tools.length, ...savedTools)
  renewals.routes = savedRoutes[0]; camera.routes = savedRoutes[1]; delete camera.tools
  env.ollamaBaseUrl = baseUrlBefore
  for (const listener of [server, model]) {listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve))}
})

for (const moduleId of ['facile', 'global', 'facile.global', 'facile.renewals']) {
  for (const tool of [S, C]) {
    test(`Step E: ${moduleId} → stesso orchestrator → ${tool}`, async () => {
      mode = tool === C ? 'communications' : 'services'
      const {result} = await post('frase non riconosciuta dal router', moduleId)
      assert.equal(result.meta.terminalTool, tool); assert.equal(result.meta.agentOutcome, 'HANDLED')
      assert.equal(result.meta.routingSource, 'agent'); assert.equal(legacy.length, 0)
      assert.equal(requests.length, 1)
      assert.deepEqual(requests[0].tools.filter(item => item.function.name !== AGENT_CONTROL).map(item => item.function.name), savedTools.map(tool => tool.name))
    })
  }
}
test('Step E: globale ed esplicito restituiscono lo stesso contratto dati', async () => {
  for (const choice of ['services', 'communications']) {
    mode = choice
    assert.deepEqual((await post('query')).result.data, (await post('query', 'facile.renewals')).result.data)
  }
})
test('Step E: spiegazione generale e saluto con/senza principal sono gestiti senza legacy', async () => {
  mode = 'general'
  for (const message of ['ciao', 'chi sei?', "spiegami cos'è un record MX"]) {
    const {result} = await post(message, 'facile', [], {}, {'X-Webcloud-Credential-Crm': ''})
    assert.equal(result.meta.agentOutcome, 'HANDLED'); assert.equal(result.meta.generalConversation, true)
    assert.equal(result.source, 'llm')
  }
  assert.equal(legacy.length, 0); assert.equal(executions.length, 0)
  assert.equal(requests[0].options.num_predict, 300, 'Mantiene il budget della risposta conversazionale nella stessa inferenza')
})
test('Step E: capacità non migrata è l’unico ingresso legacy e ha ragione osservabile', async () => {
  mode = 'legacy'
  const {result} = await post('Quante webcam sono offline?')
  assert.deepEqual(legacy, ['facile.webcamgo']); assert.equal(result.meta.agentOutcome, 'CAPABILITY_NOT_MIGRATED')
  assert.equal(result.meta.fallbackReason, 'capability-not-migrated'); assert.equal(result.meta.routingSource, 'agent')
  assert.equal(result.meta.legacyFallback, true); assert.equal(result.meta.agentAttempted, true)
  assert.equal(getChatAuditEntries({limit: 1})[0].fallbackReason, 'capability-not-migrated')
})
test('Step E: modulo legacy esplicito usa il medesimo protocollo senza vedere rinnovi', async () => {
  mode = 'legacy'
  const {result} = await post('query', 'facile.webcamgo')
  assert.equal(result.meta.legacyFallback, true)
  assert.deepEqual(requests[0].tools.map(item => item.function.name), [AGENT_CONTROL])
})
test('Step E: router legacy non restringe preventivamente i tool anche con contesto webcam', async () => {
  const {result} = await post('dati per il mio lavoro', 'facile', [], {context: {activeModuleId: 'facile.webcamgo'}})
  assert.equal(result.meta.terminalTool, S); assert.equal(legacy.length, 0)
})
test('Step E: control tool espone solo capability con credenziale e scope validi', async () => {
  mode = 'general'
  await post('ciao', 'facile', [], {}, {'X-Webcloud-Credential-Webcamgo': ''})
  const definition = requests[0].tools.find(item => item.function.name === AGENT_CONTROL)
  assert.ok(!definition.function.parameters.properties.capabilityIds.items.enum.includes('facile.webcamgo.read'))
  await post('ciao', 'facile.renewals')
  const scoped = requests[1].tools.find(item => item.function.name === AGENT_CONTROL)
  assert.ok(scoped.function.parameters.properties.capabilityIds.items.enum.every(id => id.startsWith('facile.renewals.')))
  assert.ok(requests[0].messages[0].content.includes('massimo 60 parole'))
})
test('Step E: nuovo tool nel registry è selezionabile senza modifiche a globalChat', async () => {
  const mock = {...savedTools[0], name: 'third_registered_tool', moduleId: camera.id, credential: 'webcamgo',
    capabilityId: 'facile.webcamgo.read', requiresPrincipal: false, stateful: false,
    definition: {type: 'function', function: {name: 'third_registered_tool', description: 'Terzo tool di test',
      parameters: {type: 'object', properties: {}, additionalProperties: false}}},
    execute: async () => ({ok: true, reply: 'Terzo risultato', data: {type: 'mock', total: 3}})}
  camera.tools = [mock]; mode = 'mock'
  const {result} = await post('una frase arbitraria senza sinonimi')
  assert.equal(result.meta.terminalTool, mock.name); assert.equal(legacy.length, 0)
  assert.ok(requests[0].tools.some(item => item.function.name === mock.name))
})
for (const failure of ['json', 'validation', 'policy', 'auth', 'execution', 'max', 'provider', 'empty', 'unstructured', 'bad-control', 'scope-control', 'mixed', 'error-then-legacy']) {
  test(`Step E: ${failure} → ERROR, zero fallback`, async () => {
    mode = failure
    if (failure === 'policy') tools[0].risk = 'high'
    if (failure === 'execution') tools[0].execute = async () => {throw new Error('PRIVATE_EXECUTOR')}
    const {result} = await post('query', failure === 'scope-control' ? 'facile.renewals' : 'facile', [], {},
      failure === 'auth' ? {'X-Webcloud-Credential-Crm': ''} : {})
    assert.equal(result.meta.agentOutcome, 'ERROR'); assert.equal(result.ok, false)
    assert.equal(legacy.length, 0); assert.notEqual(result.meta.legacyFallback, true)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_EXECUTOR|PRIVATE_PROVIDER/)
    if (failure === 'max') assert.equal(result.meta.maxIterationsReached, true)
    if (failure === 'mixed') assert.equal(executions.length, 0)
  })
}
test('Step E: auth middleware rifiuta prima di agente e legacy', async () => {
  assert.equal((await post('query', 'facile', [], {}, {'X-Webcloud-Credential-Crm': 'bad'})).status, 401)
  assert.equal(requests.length, 0); assert.equal(legacy.length, 0)
})
test('Step E: segnale legacy non può aggirare credenziale/principal', async () => {
  mode = 'legacy'
  const {result} = await post('query', 'facile', [], {}, {'X-Webcloud-Credential-Webcamgo': ''})
  assert.equal(result.meta.agentOutcome, 'ERROR'); assert.equal(legacy.length, 0)
})
test('Step E: registry invalido è ERROR e non fallback', async () => {
  tools.push({...tools[0], name: 'bad_registry'})
  const {result} = await post('query')
  assert.equal(result.meta.agentOutcome, 'ERROR'); assert.equal(requests.length, 0); assert.equal(legacy.length, 0)
})
const historyFor = result => [{role: 'assistant', content: result.reply, meta: result.meta, data: result.data}]
test('Step E: refine reale di route mantiene 83 → 27 → 24 e snapshot/paginazione', async () => {
  let result = (await post('initial')).result; assert.equal(result.data.totale, 83)
  result = (await post('year', 'facile', historyFor(result))).result; assert.equal(result.data.totale, 27)
  result = (await post('exclude', 'facile.renewals', historyFor(result))).result; assert.equal(result.data.totale, 24)
  assert.deepEqual(result.meta.agentState.args, {customerOrGroup: 'Zilio Group', expiresYear: 2026, dontRenewMode: 'exclude'})
  assert.equal(requests.filter(item => item.format).length, 2); assert.equal(requests.length, 5)
})
test('Step E: replace resetta query e switch seleziona comunicazioni latest', async () => {
  let result = (await post('initial')).result
  decision = {stateMode: 'replace', entityReference: ''}
  result = (await post('independent', 'facile', historyFor(result))).result
  assert.deepEqual(result.meta.agentState.args, {expiresYear: 2027})
  decision = {stateMode: 'switch', entityReference: ''}; mode = 'communications'
  result = (await post('latest', 'facile', historyFor(result))).result
  assert.equal(result.meta.terminalTool, C); assert.deepEqual(result.meta.agentState.args, {latest: true})
  assert.equal(result.data.shown, 1); assert.equal(result.data.items[0].sentAutomatically, false)
})
test('Step E: multi-module legacy conserva entrambe le letture dopo outcome esplicito', async () => {
  mode = 'multi'
  const {result} = await post('Quante webcam sono offline e quali servizi sono da rinnovare?')
  assert.deepEqual(new Set(legacy), new Set([camera.id, renewals.id]))
  assert.equal(result.meta.fallbackReason, 'capability-not-migrated')
})
test('Step E: provider error del planner Step C è ERROR senza nuovo planner', async () => {
  const result = await executeAgentRequest({message: 'follow-up', credentials, principal,
    history: [{role: 'assistant', meta: {agentState: {tool: S, args: {}, moduleId: renewals.id}}}],
    callModel: async () => {throw Object.assign(new Error('PRIVATE_STATE'), {name: 'OllamaProviderError'})}})
  assert.equal(result.outcome, 'ERROR'); assert.equal(result.response.data.code, 'AGENT_PROVIDER_ERROR')
})
test('Step E: outcome conversazionale e migrazione richiedono payload distinti e validi', async () => {
  for (const args of [
    {outcome: 'GENERAL_CONVERSATION', reply: ''},
    {outcome: 'GENERAL_CONVERSATION', reply: 'ciao', capabilityIds: ['facile.renewals.read']},
    {outcome: 'CAPABILITY_NOT_MIGRATED'},
    {outcome: 'CAPABILITY_NOT_MIGRATED', capabilityIds: ['facile.renewals.read'], reply: 'non disponibile'},
  ]) {
    const result = await executeAgentRequest({message: 'query', credentials, principal, callModel: async () => call(AGENT_CONTROL, args)})
    assert.equal(result.outcome, 'ERROR'); assert.equal(result.response.meta.toolErrors[0].code, 'TOOL_VALIDATION_ERROR')
  }
  assert.equal(legacy.length, 0); assert.equal(executions.length, 0)
})
test('Step E: ok=false è un errore di esecuzione e conta una sola invocazione', async () => {
  tools[0].execute = async () => {executions.push(S); return {ok: false, data: {type: 'unverified'}}}
  let calls = 0
  const result = await executeAgentRequest({message: 'query', credentials, principal,
    callModel: async () => ++calls === 1 ? call(S) : {content: 'Esito incerto'}})
  assert.equal(result.outcome, 'ERROR'); assert.equal(executions.length, 1)
  assert.equal(result.response.meta.toolCalls.length, 1)
  assert.equal(result.response.meta.toolErrors[0].code, 'TOOL_EXECUTION_ERROR')
  assert.equal(result.response.data.type, 'tool-error'); assert.equal(legacy.length, 0)
})

for (const moduleId of ['facile', 'facile.renewals']) {
  test(`F6 POST /api/chat: ${moduleId}, due dettagli terminali → ERROR, zero esecuzioni/fallback`, async () => {
    mode = 'terminal-batch'
    const {status, result} = await post('confronta DomAssLicBase e Aruba-pecprem', moduleId)
    assert.equal(status, 200)
    assert.equal(result.ok, false)
    assert.equal(result.meta.agentOutcome, 'ERROR')
    assert.equal(result.meta.agentHandled, false)
    assert.equal(result.meta.toolErrors[0].code, 'AGENT_TERMINAL_BATCH_UNSUPPORTED')
    assert.equal(result.meta.toolBatch.status, 'rejected')
    assert.equal(result.meta.toolBatch.requested, 2)
    assert.equal(result.meta.toolBatch.attempted, 0)
    assert.equal(result.meta.terminalTool, undefined)
    assert.equal(result.data.type, 'tool-error')
    assert.equal(executions.length, 0)
    assert.equal(legacy.length, 0)
    assert.equal(requests.length, 1)
    assert.notEqual(result.meta.legacyFallback, true)
    assert.equal(result.meta.fallbackReason, undefined)
  })
}

test('F6 POST /api/chat: terminale seguito da args invalidi → preflight, zero esecuzioni', async () => {
  mode = 'terminal-batch-invalid'
  const {result} = await post('due letture')
  assert.equal(result.meta.agentOutcome, 'ERROR')
  assert.equal(result.meta.toolErrors[0].code, 'TOOL_VALIDATION_ERROR')
  assert.equal(result.meta.toolErrors[0].callIndex, 1)
  assert.equal(executions.length, 0)
  assert.equal(legacy.length, 0)
})

test('F6 POST /api/chat: secondo read fallito non presenta il primo come completo', async () => {
  mode = 'nonterminal-batch-failure'
  for (const tool of tools) tool.terminal = false
  tools.find(tool => tool.name === C).execute = async () => {
    executions.push({name: C}); throw new Error('PRIVATE_BATCH_FAILURE')
  }
  const {result} = await post('due letture')
  assert.equal(result.ok, false)
  assert.equal(result.meta.agentOutcome, 'ERROR')
  assert.equal(result.meta.toolErrors[0].code, 'TOOL_EXECUTION_ERROR')
  assert.equal(result.meta.toolBatch.status, 'failed')
  assert.equal(result.meta.toolBatch.attempted, 2)
  assert.equal(result.meta.toolBatch.completed, 1)
  assert.deepEqual(executions.map(item => item.name), [S, C])
  assert.equal(result.data.type, 'tool-error')
  assert.equal(result.meta.agentState, undefined)
  assert.equal(legacy.length, 0)
  assert.equal(requests.length, 1)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BATCH_FAILURE/)
})
