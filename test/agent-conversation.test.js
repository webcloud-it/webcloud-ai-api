import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import http from 'node:http'
import express from 'express'

import {executeGlobalConversation} from '../src/core/orchestrator/globalConversation.js'
import {collectModuleTools, getRegisteredTools} from '../src/modules/registry.js'
import {renewalsTools} from '../src/modules/facile/renewals/tools.js'
import {createAuthTokenMiddleware} from '../src/middlewares/authToken.js'
import chatRouter from '../src/routes/chat.js'
import {env} from '../src/config/env.js'
import {buildAgentToolDefinition, compactAgentResult} from '../src/core/tools/agentState.js'

const credentials = {crm: 'crm-session'}
const principal = {id: 'operator-1', roleId: 'operator', roleName: null, source: 'crm'}
const toolCall = (name, args, stateMode = 'replace') => {
  let payload = {stateMode, args}
  if (typeof args === 'string') {
    try { payload = JSON.stringify({stateMode, args: JSON.parse(args)}) }
    catch (_) { payload = args }
  }
  return {role: 'assistant', content: '', tool_calls: [{function: {name, arguments: payload}}]}
}
const noCall = {role: 'assistant', content: 'Non posso completare la richiesta.'}

function fixture(overrides = {}) {
  const calls = []
  const tool = {
    ...renewalsTools[0],
    execute: async (args, context) => {
      calls.push({args, context})
      return {ok: true, moduleId: 'facile.renewals', reply: 'Risultato verificato.', data: {type: 'service-list', totale: 1}}
    },
    ...overrides,
  }
  const requests = []
  async function run(args, options = {}, corrections = []) {
    const responses = [toolCall(tool.name, args, options.history ? 'refine' : 'replace'), ...corrections, noCall]
    return executeGlobalConversation({
      message: 'Richiesta di test', credentials, principal,
      fallbackOnNoTool: true,
      listTools: () => [tool],
      callModel: async request => {
        requests.push(structuredClone(request))
        return responses.shift() || noCall
      },
      ...options,
    })
  }
  return {tool, calls, requests, run}
}

function assertDenied(result, calls, code) {
  assert.equal(calls.length, 0)
  assert.notEqual(result, null, 'Un errore tool non deve abilitare il fallback legacy')
  assert.equal(result.data.type, 'tool-error')
  assert.equal(result.meta.toolErrors[0].code, code)
  assert.equal(result.meta.toolCalls.length, 0)
}

test('read/low autorizzato esegue con il principal autenticato e args validi', async () => {
  const {run, calls} = fixture()
  const args = {customerOrGroup: 'Zilio Group', expiresYear: 2026, dontRenewMode: 'exclude'}
  const result = await run(args)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, args)
  assert.deepEqual(calls[0].context.principal, principal)
  assert.equal(result.meta.terminalTool, 'renewals_search_services')
  assert.equal(result.reply, 'Risultato verificato.')
})

test('oggetto JSON serializzato valido viene accettato senza coercizione', async () => {
  const {run, calls} = fixture()
  await run('{"expiresYear":2026}')
  assert.deepEqual(calls[0].args, {expiresYear: 2026})
})

test('credenziale assente non esegue e non abilita il fallback', async () => {
  const {run, calls, requests} = fixture()
  assertDenied(await run({}, {credentials: {}}), calls, 'TOOL_AUTHORIZATION_DENIED')
  assert.equal(requests.length, 0)
})

for (const invalidPrincipal of [null, {id: 'operator-1'}, {id: '', source: 'crm'}, {id: 'operator-1', source: 'webcamgo'}]) {
  test(`principal assente o incoerente viene rifiutato: ${JSON.stringify(invalidPrincipal)}`, async () => {
    const {run, calls} = fixture()
    assertDenied(await run({}, {principal: invalidPrincipal}), calls, 'TOOL_AUTHORIZATION_DENIED')
  })
}

for (const metadata of [
  {mode: 'write', risk: 'high'}, {mode: 'preview', risk: 'low'},
  {mode: 'read', risk: 'high'}, {mode: 'read', risk: 'medium'}, {mode: 'unknown', risk: 'low'},
]) {
  test(`gate centrale nega ${metadata.mode}/${metadata.risk}`, async () => {
    const {run, calls} = fixture(metadata)
    assertDenied(await run({}), calls, 'TOOL_POLICY_DENIED')
  })
}

for (const metadata of [
  {capabilityId: 'facile.invented.read'},
  {capabilityId: 'facile.webcamgo.read'},
  {capabilityId: 'facile.renewals.mutate'},
]) {
  test(`usa il catalogo esistente per negare capability incoerente: ${metadata.capabilityId}`, async () => {
    const {run, calls} = fixture(metadata)
    assertDenied(await run({}), calls, 'TOOL_CAPABILITY_DENIED')
  })
}

test('tool sconosciuto restituisce role=tool senza dispatch né fallback', async () => {
  const {tool, run, calls, requests} = fixture()
  const responses = [toolCall('unknown_tool', {}), noCall]
  const result = await run({}, {callModel: async request => {
    requests.push(structuredClone(request))
    return responses.shift()
  }})
  assertDenied(result, calls, 'TOOL_UNAVAILABLE')
  assert.equal(requests[1].messages.at(-1).role, 'tool')
  assert.equal(requests[1].messages.at(-1).tool_name, 'unknown_tool')
  assert.equal(tool.name, 'renewals_search_services')
})

const invalidArguments = [
  ['JSON rotto', '{bad json', 'INVALID_TOOL_ARGUMENTS'],
  ['array', [], 'INVALID_TOOL_ARGUMENTS'],
  ['array JSON', '[]', 'INVALID_TOOL_ARGUMENTS'],
  ['numero', 3, 'INVALID_TOOL_ARGUMENTS'],
  ['booleano', false, 'INVALID_TOOL_ARGUMENTS'],
  ['null', null, 'INVALID_TOOL_ARGUMENTS'],
  ['argomenti mancanti', undefined, 'INVALID_TOOL_ARGUMENTS'],
  ['stringa JSON', '"ciao"', 'INVALID_TOOL_ARGUMENTS'],
  ['stringa non JSON', 'ciao', 'INVALID_TOOL_ARGUMENTS'],
  ['proprietà extra', {includeDontRenew: true}, 'TOOL_VALIDATION_ERROR'],
  ['tipo errato', {expiresYear: '2026'}, 'TOOL_VALIDATION_ERROR'],
  ['enum errato', {dontRenewMode: 'exlcude'}, 'TOOL_VALIDATION_ERROR'],
  ['anno sotto minimo', {expiresYear: 1999}, 'TOOL_VALIDATION_ERROR'],
  ['anno sopra massimo', {expiresYear: 2101}, 'TOOL_VALIDATION_ERROR'],
  ['intero frazionario', {limit: 1.5}, 'TOOL_VALIDATION_ERROR'],
  ['limite sotto minimo', {limit: 0}, 'TOOL_VALIDATION_ERROR'],
  ['limite sopra massimo', {limit: 51}, 'TOOL_VALIDATION_ERROR'],
  ['offset negativo', {offset: -1}, 'TOOL_VALIDATION_ERROR'],
  ['enum elemento array', {flags: ['dont-renew']}, 'TOOL_VALIDATION_ERROR'],
  ['maxItems', {flags: Array(5).fill('to-renew')}, 'TOOL_VALIDATION_ERROR'],
]
for (const [label, args, code] of invalidArguments) {
  test(`argomenti invalidi: ${label}, zero esecuzioni e nessun fallback`, async () => {
    const {run, calls, requests} = fixture()
    const result = await run(args)
    assertDenied(result, calls, code)
    const errorMessage = requests[1].messages.at(-1)
    assert.equal(errorMessage.role, 'tool')
    assert.equal(JSON.parse(errorMessage.content).error.code, code)
  })
}

function historyFor(args) {
  return [{role: 'assistant', meta: {
    moduleId: 'facile.renewals',
    agentState: {tool: 'renewals_search_services', moduleId: 'facile.renewals', args},
  }}]
}

function stateFixture() {
  const calls = []
  const requests = []
  const tools = renewalsTools.map(tool => ({...tool, execute: async args => {
    calls.push({name: tool.name, args})
    return {ok: true, reply: 'Risultato verificato.', moduleId: tool.moduleId,
      data: {type: 'fixture', total: 83},
      modelContent: {total: 83, nextOffset: 20, items: [{customerName: 'Cliente Zilio', groupName: 'Zilio Group'}]},
    }
  }}))
  async function turn(name, args, stateMode = 'replace', history = [], options = {}) {
    const responses = [toolCall(name, args, stateMode), noCall]
    return executeGlobalConversation({
      message: 'Turno di test', credentials, principal, history,
      routingSource: 'agent-history', fallbackOnNoTool: true,
      listTools: () => tools,
      callModel: async request => { requests.push(structuredClone(request)); return responses.shift() || noCall },
      ...options,
    })
  }
  return {calls, requests, tools, turn}
}

const S = 'renewals_search_services'
const C = 'renewals_search_communications'
const stateHistory = result => [{role: 'assistant', content: result.reply, meta: result.meta, data: result.data}]

test('Step C: primo tool senza stato usa replace e conserva gli argomenti validati', async () => {
  const {turn, calls} = stateFixture()
  const result = await turn(S, {customerOrGroup: 'Zilio Group'})
  assert.deepEqual(calls[0].args, {customerOrGroup: 'Zilio Group'})
  assert.deepEqual(result.meta.agentState.args, calls[0].args)
  assert.equal(result.meta.agentState.tool, S)
})

test('Step C: refine successivi mantengono cliente, anno e dontRenewMode', async () => {
  const {turn, calls} = stateFixture()
  let result = await turn(S, {customerOrGroup: 'Zilio Group'})
  result = await turn(S, {expiresYear: 2026}, 'refine', stateHistory(result))
  assert.deepEqual(calls[1].args, {customerOrGroup: 'Zilio Group', expiresYear: 2026})
  result = await turn(S, {dontRenewMode: 'exclude'}, 'refine', stateHistory(result))
  assert.deepEqual(result.meta.agentState.args, {customerOrGroup: 'Zilio Group', expiresYear: 2026, dontRenewMode: 'exclude'})
  result = await turn(S, {dontRenewMode: 'only'}, 'refine', stateHistory(result))
  assert.equal(result.meta.agentState.args.dontRenewMode, 'only')
  assert.equal(result.meta.agentState.args.customerOrGroup, 'Zilio Group')
})

for (const removed of ['customerOrGroup', 'dontRenewMode']) {
  test(`Step C: replace elimina ${removed} e conserva solo i nuovi argomenti`, async () => {
    const {turn, calls} = stateFixture()
    const prior = await turn(S, {customerOrGroup: 'Zilio Group', expiresYear: 2026, dontRenewMode: 'exclude'})
    const result = await turn(S, {expiresYear: 2027}, 'replace', stateHistory(prior))
    assert.equal(Object.hasOwn(result.meta.agentState.args, removed), false)
    assert.deepEqual(calls[1].args, {expiresYear: 2027})
  })
}

test('Step C: servizi → comunicazioni espone entrambi i tool e passa il cliente esplicito', async () => {
  const {turn, calls, requests} = stateFixture()
  const prior = await turn(S, {customerOrGroup: 'Zilio Group', expiresYear: 2026, dontRenewMode: 'exclude'})
  const result = await turn(C, {customerOrGroup: 'Zilio Group', latest: true}, 'replace', stateHistory(prior))
  assert.equal(result.meta.terminalTool, C)
  assert.deepEqual(calls[1].args, {customerOrGroup: 'Zilio Group', latest: true})
  assert.deepEqual(requests[1].tools.map(tool => tool.function.name), [S, C])
  assert.equal(result.meta.agentState.tool, C, 'Il tool terminale stateless sostituisce lo snapshot precedente')
})

test('Step C: cambio tool non copia argomenti nemmeno se il modello indica refine', async () => {
  const {turn, calls} = stateFixture()
  const prior = await turn(S, {customerOrGroup: 'Zilio Group', expiresYear: 2026, dontRenewMode: 'exclude'})
  await turn(C, {latest: true}, 'refine', stateHistory(prior))
  assert.deepEqual(calls[1].args, {latest: true})
})

test('Step C: comunicazioni → servizi usa il risultato compatto per il riferimento e non fonde latest', async () => {
  const {turn, calls, requests} = stateFixture()
  const prior = await turn(C, {latest: true})
  assert.equal(prior.meta.agentState.result.items[0].customerName, 'Cliente Zilio')
  const result = await turn(S, {customerOrGroup: 'Cliente Zilio'}, 'replace', stateHistory(prior))
  assert.equal(result.meta.terminalTool, S)
  assert.deepEqual(calls[1].args, {customerOrGroup: 'Cliente Zilio'})
  assert.match(requests[1].messages[0].content, /Cliente Zilio/)
})

test('Step C: correzione del solo anno conserva gli altri filtri', async () => {
  const {turn, calls} = stateFixture()
  const prior = await turn(S, {customerOrGroup: 'Zilio Group', expiresYear: 2026, dontRenewMode: 'exclude'})
  await turn(S, {expiresYear: 2027}, 'refine', stateHistory(prior))
  assert.deepEqual(calls[1].args, {customerOrGroup: 'Zilio Group', expiresYear: 2027, dontRenewMode: 'exclude'})
})

for (const args of [null, [], 'bad-state']) {
  test(`Step C: refine blocca la forma invalida dello stato client ${JSON.stringify(args)}`, async () => {
    const {turn, calls} = stateFixture()
    const result = await turn(S, {expiresYear: 2027}, 'refine', historyFor(args))
    assertDenied(result, calls, 'AGENT_STATE_INVALID')
  })
}

test('Step C: stato client di modulo incoerente non può essere raffinato', async () => {
  const {turn, calls} = stateFixture()
  const history = historyFor({customerOrGroup: 'Zilio Group'})
  history[0].meta.agentState.moduleId = 'facile.webcamgo'
  assertDenied(await turn(S, {expiresYear: 2027}, 'refine', history), calls, 'AGENT_STATE_INVALID')
})

test('Step C: validation dopo merge resta vincolante; replace può abbandonare lo stato invalido', async () => {
  const {turn, calls} = stateFixture()
  assertDenied(await turn(S, {expiresYear: 2027}, 'refine', historyFor({dontRenewMode: 'bad'})), calls, 'TOOL_VALIDATION_ERROR')
  const result = await turn(S, {expiresYear: 2027}, 'replace', historyFor({dontRenewMode: 'bad'}))
  assert.equal(result.meta.toolErrors, undefined)
  assert.deepEqual(calls[0].args, {expiresYear: 2027})
})

for (const payload of [{args: {}}, {stateMode: 'guess', args: {}}, {stateMode: 'replace'}, {stateMode: 'refine', args: {}, extra: true}]) {
  test(`Step C: protocollo invalido non esegue e non causa fallback ${JSON.stringify(payload)}`, async () => {
    const {turn, calls, requests} = stateFixture()
    let iteration = 0
    const result = await turn(S, {}, 'replace', [], {callModel: async request => {
      requests.push(structuredClone(request))
      return iteration++ === 0 ? {role: 'assistant', tool_calls: [{function: {name: S, arguments: payload}}]} : noCall
    }})
    assertDenied(result, calls, 'AGENT_STATE_PROTOCOL_ERROR')
    assert.equal(requests[1].messages.at(-1).role, 'tool')
  })
}

test('Step C: refine senza uno stato precedente viene corretto con replace nella stessa conversazione', async () => {
  const {turn, calls} = stateFixture()
  const responses = [toolCall(S, {expiresYear: 2027}, 'refine'), toolCall(S, {expiresYear: 2027}, 'replace')]
  const result = await turn(S, {}, 'replace', [], {callModel: async () => responses.shift()})
  assert.equal(result.meta.toolErrors[0].code, 'AGENT_STATE_INVALID')
  assert.equal(calls.length, 1)
})

test('Step C: scope esplicito del modulo viene mantenuto e non espande il catalogo', async () => {
  const {turn, requests} = stateFixture()
  await turn(S, {}, 'replace', historyFor({customerOrGroup: 'Zilio Group'}), {toolModuleId: 'facile.renewals'})
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), [S, C])
  const missing = await turn(S, {}, 'replace', [], {toolModuleId: 'facile.webcamgo'})
  assert.equal(missing, null)
})

test('Step C: history resta compatta, comprende user e assistant e non replica le liste client', async () => {
  const {turn, requests} = stateFixture()
  const history = [
    {role: 'user', content: 'Che servizi ha Zilio Group?'},
    {role: 'assistant', content: 'Risultato precedente. '.repeat(1000), data: {items: Array(2000).fill({secretMarker: 'FULL_TABLE'})},
      meta: {agentState: {tool: S, moduleId: 'facile.renewals', args: {customerOrGroup: 'Zilio Group'}, result: {items: Array(2000).fill({customerName: 'Cliente Zilio'})}}}},
    {role: 'user', content: 'Turno di test'},
  ]
  await turn(C, {customerOrGroup: 'Zilio Group', latest: true}, 'replace', history)
  const messages = requests[0].messages
  assert.deepEqual(messages.map(item => item.role), ['system', 'user', 'assistant', 'user'])
  assert.equal(messages[2].content.length, 320)
  assert.doesNotMatch(JSON.stringify(messages), /FULL_TABLE/)
  assert.ok(JSON.stringify(messages).length < 4000)
  assert.ok(JSON.stringify(compactAgentResult(history[1].meta.agentState.result)).length < 3500)
})

test('Step C: projection del protocollo non muta o duplica gli schemi business', () => {
  for (const tool of renewalsTools) {
    const before = structuredClone(tool.definition)
    const projection = buildAgentToolDefinition(tool)
    assert.equal(projection.function.parameters.properties.args, tool.definition.function.parameters)
    assert.deepEqual(tool.definition, before)
    assert.equal(Object.hasOwn(tool.definition.function.parameters.properties, 'stateMode'), false)
  }
})

test('Step C: paginazione refine conserva limit/offset nello stato, replace li abbandona', async () => {
  const {turn, calls} = stateFixture()
  const prior = await turn(S, {customerOrGroup: 'Zilio Group', limit: 10, offset: 10})
  const next = await turn(S, {offset: 20}, 'refine', stateHistory(prior))
  assert.deepEqual(next.meta.agentState.args, {customerOrGroup: 'Zilio Group', limit: 10, offset: 20})
  await turn(S, {expiresYear: 2027}, 'replace', stateHistory(next))
  assert.deepEqual(calls[2].args, {expiresYear: 2027})
})

test('Step C: offset invalido ereditato è validato dopo merge e non esegue', async () => {
  const {turn, calls} = stateFixture()
  assertDenied(await turn(S, {}, 'refine', historyFor({offset: -1})), calls, 'TOOL_VALIDATION_ERROR')
})

test('Step C: JSON annidato come stringa non aggira il tipo object del protocollo', async () => {
  const {turn, calls} = stateFixture()
  const responses = [{role: 'assistant', tool_calls: [{function: {name: S,
    arguments: {stateMode: 'replace', args: '{"expiresYear":2027}'},
  }}]}, noCall]
  const result = await turn(S, {}, 'replace', [], {callModel: async () => responses.shift()})
  assertDenied(result, calls, 'INVALID_TOOL_ARGUMENTS')
})

test('Step C: riepilogo resta strutturato e limitato anche con campi e liste enormi', () => {
  const compact = compactAgentResult({items: Array(10000).fill(Object.fromEntries(
    Array.from({length: 30}, (_, i) => [`field-${i}`, 'x'.repeat(10000)]),
  ))})
  assert.equal(typeof compact, 'object')
  assert.ok(JSON.stringify(compact).length < 2200)
  assert.equal(compact.items.length, 1)
  assert.deepEqual(compactAgentResult(compact), compact)
})

test('valida agentState non fidato dopo il merge, senza eseguire', async () => {
  const {run, calls, requests} = fixture()
  const result = await run({dontRenewMode: 'exclude'}, {
    routingSource: 'agent-history', history: historyFor({expiresYear: '2026'}),
  })
  assertDenied(result, calls, 'TOOL_VALIDATION_ERROR')
  assert.deepEqual(result.meta.toolErrors[0].issues, [{path: '$.expiresYear', keyword: 'type'}])
  assert.match(requests[0].messages[0].content, /ricevuto dal client, da validare/)
  assert.doesNotMatch(requests[0].messages[0].content, /già verificato/)
})

test('valida anche proprietà extra ereditate da agentState', async () => {
  const {run, calls} = fixture()
  assertDenied(await run({}, {
    routingSource: 'agent-history', history: historyFor({includeDontRenew: true}),
  }), calls, 'TOOL_VALIDATION_ERROR')
})

test('validazione del merge permette di correggere un valore client con il nuovo argomento', async () => {
  const {run, calls} = fixture()
  await run({expiresYear: 2026}, {
    routingSource: 'agent-history', history: historyFor({customerOrGroup: 'Zilio Group', expiresYear: '2026'}),
  })
  assert.deepEqual(calls[0].args, {customerOrGroup: 'Zilio Group', expiresYear: 2026})
})

test('errore di validazione viene corretto nella seconda iterazione', async () => {
  const {run, calls, requests, tool} = fixture()
  const result = await run({expiresYear: '2026'}, {}, [toolCall(tool.name, {expiresYear: 2026})])
  assert.equal(requests.length, 2)
  assert.equal(calls.length, 1)
  assert.equal(requests[1].messages.at(-1).role, 'tool')
  const error = JSON.parse(requests[1].messages.at(-1).content)
  assert.equal(error.ok, false)
  assert.deepEqual(error.error.issues, [{path: '$.expiresYear', keyword: 'type'}])
  assert.equal(result.reply, 'Risultato verificato.')
  assert.equal(result.meta.toolErrors.length, 1)
})

test('errori ripetuti rispettano MAX_AGENT_ITERATIONS senza fallback', async () => {
  const {run, calls, requests, tool} = fixture()
  const result = await run({limit: 0}, {callModel: async request => {
    requests.push(structuredClone(request))
    return toolCall(tool.name, {limit: 0})
  }})
  assert.equal(calls.length, 0)
  assert.equal(requests.length, 4)
  assert.equal(result.ok, false)
  assert.equal(result.meta.maxIterationsReached, true)
  assert.equal(result.meta.toolErrors.length, 4)
  assert.notEqual(result, null)
})

test('errore di esecuzione non abilita fallback e non espone dettagli interni', async () => {
  const {run} = fixture({execute: async () => { throw new Error('secret upstream detail') }})
  const result = await run({})
  assert.notEqual(result, null)
  assert.equal(result.meta.toolErrors[0].code, 'TOOL_EXECUTION_ERROR')
  assert.doesNotMatch(JSON.stringify(result), /secret upstream detail/)
})

test('fallback resta disponibile per modulo senza tool e prima di qualsiasi errore', async () => {
  const {run} = fixture()
  assert.equal(await run({}, {listTools: () => []}), null)
  assert.equal(await run({}, {callModel: async () => noCall}), null)
})

test('registry filtra per credenziale ma permette di distinguere tool indisponibili da non migrati', () => {
  assert.equal(getRegisteredTools().length, 0)
  assert.equal(getRegisteredTools({includeUnavailable: true}).length, 2)
  assert.equal(getRegisteredTools({credentials}).length, 2)
})

for (const [label, change] of [
  ['nome mancante', {name: ''}], ['definition mancante', {definition: null}],
  ['execute non funzione', {execute: null}], ['mode mancante', {mode: undefined}],
  ['risk mancante', {risk: undefined}], ['credential mancante', {credential: undefined}],
  ['capability mancante', {capabilityId: undefined}], ['requiresPrincipal mancante', {requiresPrincipal: undefined}],
  ['modulo incoerente', {moduleId: 'facile.webcamgo'}],
]) {
  test(`registry rifiuta ${label}`, () => {
    const {tool} = fixture(change)
    assert.throws(() => collectModuleTools([{id: 'facile.renewals', tools: [tool]}]), /Registrazione tool non valida/)
  })
}

test('registry rifiuta duplicati anche tra moduli e prima del filtro credenziale', () => {
  const {tool} = fixture()
  const other = {...tool, moduleId: 'other-module'}
  assert.throws(() => collectModuleTools([
    {id: tool.moduleId, tools: [tool]}, {id: other.moduleId, tools: [other]},
  ]), /Nome tool duplicato/)
})

test('registry non ignora un elenco tools malformato', () => {
  assert.throws(() => collectModuleTools([{id: 'facile.renewals', tools: {}}]), /tools deve essere un array/)
})

test('registry rifiuta nome definition incoerente e schema con keyword non supportata', () => {
  const {tool} = fixture()
  const definition = structuredClone(tool.definition)
  definition.function.name = 'different_name'
  assert.throws(() => collectModuleTools([{id: tool.moduleId, tools: [{...tool, definition}]}]), /definition incompleta/)
  definition.function.name = tool.name
  definition.function.parameters.anyOf = []
  assert.throws(() => collectModuleTools([{id: tool.moduleId, tools: [{...tool, definition}]}]), /keyword non supportata: anyOf/)
})

test('required nello schema è vincolante senza un secondo elenco nel tool', async () => {
  const definition = structuredClone(renewalsTools[0].definition)
  definition.function.parameters.required = ['customerOrGroup']
  const {run, calls} = fixture({definition})
  const result = await run({})
  assertDenied(result, calls, 'TOOL_VALIDATION_ERROR')
  assert.deepEqual(result.meta.toolErrors[0].issues, [{path: '$.customerOrGroup', keyword: 'required'}])
})

test('route passa req.auth.principal reale all’esecuzione, ignorando il principal nel body', async () => {
  const tool = renewalsTools[0]
  const originalExecute = tool.execute
  const originalBaseUrl = env.ollamaBaseUrl
  let executionContext = null
  const modelServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({message: toolCall(tool.name, {})}))
  })
  modelServer.listen(0, '127.0.0.1')
  await once(modelServer, 'listening')
  env.ollamaBaseUrl = `http://127.0.0.1:${modelServer.address().port}`
  tool.execute = async (_args, context) => {
    executionContext = context
    return {ok: true, moduleId: tool.moduleId, reply: 'Verificato', data: {type: 'service-list', items: []}}
  }
  const app = express()
  app.use(express.json())
  app.use(createAuthTokenMiddleware({validateCrmToken: async () => principal}))
  app.use('/api/chat', chatRouter)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    for (const message of ['Che servizi ha Zilio Group?', 'Controllo generico']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer session', 'X-Webcloud-Credential-Crm': credentials.crm},
        body: JSON.stringify({moduleId: 'facile', message, principal: {id: 'forged', source: 'crm'}}),
      })
      const result = await response.json()
      assert.equal(response.status, 200)
      assert.equal(result.meta.terminalTool, tool.name)
      assert.deepEqual(executionContext.principal, principal)
    }
  } finally {
    tool.execute = originalExecute
    env.ollamaBaseUrl = originalBaseUrl
    server.closeAllConnections()
    modelServer.closeAllConnections()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => modelServer.close(resolve))])
  }
})
