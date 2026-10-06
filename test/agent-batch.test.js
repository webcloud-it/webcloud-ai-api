import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {executeAgentRequest, executeGlobalConversation} from '../src/core/orchestrator/globalConversation.js'
import {AGENT_CONTROL} from '../src/core/orchestrator/agentOutcome.js'
import {renewalsTools} from '../src/modules/facile/renewals/tools.js'

const credentials = {crm: 'fixture-session', webcamgo: 'fixture-camera'}
const principal = {id: 'fixture-operator', source: 'crm'}
const S = 'renewals_search_services', P = 'renewals_get_plan', C = 'renewals_search_communications'
const call = (name, args = {}) => ({function: {name, arguments: args}})
const batch = calls => ({role: 'assistant', content: '', tool_calls: calls})
const migration = call(AGENT_CONTROL, {outcome: 'CAPABILITY_NOT_MIGRATED', legacyAreas: ['WebcamGo']})
const general = batch([call(AGENT_CONTROL, {outcome: 'GENERAL_CONVERSATION', reply: 'Entrambe le letture verificate.'})])

function fixture(overrides = {}) {
  const executions = [], requests = []
  const tools = [S, P, C].map(name => ({
    ...renewalsTools.find(tool => tool.name === name),
    execute: async args => {
      executions.push({name, args})
      return {ok: true, moduleId: 'facile.renewals', reply: `Risultato verificato ${name}.`,
        data: {type: 'fixture', name, args, total: 1}}
    },
    ...overrides[name],
  }))
  async function run(calls, options = {}, followups = [general]) {
    const responses = [batch(calls), ...followups]
    return executeAgentRequest({message: 'Richiesta batch', credentials, principal, listTools: () => tools,
      callModel: async request => {
        requests.push(structuredClone(request))
        if (request.format) return {content: JSON.stringify({stateMode: 'refine', entityReference: ''})}
        return responses.shift() || {content: ''}
      }, ...options})
  }
  return {tools, executions, requests, run}
}

function assertRejected(result, fixture, code, requested = 2) {
  assert.equal(result.outcome, 'ERROR')
  assert.equal(result.response.ok, false)
  assert.equal(result.response.meta.agentHandled, false)
  assert.equal(fixture.executions.length, 0)
  assert.equal(result.response.meta.toolCalls.length, 0)
  assert.equal(result.response.meta.toolBatch.status, 'rejected')
  assert.equal(result.response.meta.toolBatch.requested, requested)
  assert.equal(result.response.meta.toolBatch.attempted, 0)
  assert.equal(result.response.meta.toolBatch.completed, 0)
  assert.ok(result.response.meta.toolErrors.some(error => error.code === code))
  assert.equal(result.response.meta.capabilityNotMigrated, undefined)
  assert.notEqual(result.response.meta.legacyFallback, true)
  assert.equal(result.response.meta.terminalTool, undefined)
  assert.equal(result.response.meta.agentState, undefined)
  assert.equal(result.response.data.type, 'tool-error')
}

test('F6: batch reale di due get_plan non restituisce il dettaglio del primo come HANDLED', async () => {
  const f = fixture()
  const result = await f.run([call(P, {plan: 'DomAssLicBase'}), call(P, {plan: 'Aruba-pecprem'})])
  assertRejected(result, f, 'AGENT_TERMINAL_BATCH_UNSUPPORTED')
  assert.deepEqual(result.response.meta.toolBatch.calls, [P, P])
  assert.equal(f.requests.length, 1, 'Non trasforma la composizione rifiutata in una chiamata singola')
  assert.doesNotMatch(result.response.reply, /Risultato verificato/)
})

for (const names of [[S, C], [C, S]]) {
  test(`F6: terminale e non terminale, ordine ${names.join(',')}, zero esecuzioni`, async () => {
    const f = fixture({[S]: {terminal: false}})
    assertRejected(await f.run(names.map(name => call(name))), f, 'AGENT_TERMINAL_BATCH_UNSUPPORTED')
  })
}

test('F6: terminale in coda a due non terminali rifiuta anche il prefisso', async () => {
  const f = fixture({[S]: {terminal: false}, [C]: {terminal: false}})
  assertRejected(await f.run([call(S), call(C), call(P, {plan: 'Aruba-pecprem'})]), f,
    'AGENT_TERMINAL_BATCH_UNSUPPORTED', 3)
})

for (const [label, invalid, code, overrides, options] of [
  ['tool sconosciuto', call('unknown_tool'), 'TOOL_UNAVAILABLE'],
  ['JSON malformato', call(C, '{invalid'), 'INVALID_TOOL_ARGUMENTS'],
  ['schema errato', call(C, {latest: 'yes'}), 'TOOL_VALIDATION_ERROR'],
  ['write/high', call(C), 'TOOL_POLICY_DENIED', {[C]: {mode: 'write', risk: 'high'}}],
  ['credenziale assente', call(C), 'TOOL_AUTHORIZATION_DENIED', {[C]: {credential: 'webcamgo'}}, {credentials: {crm: 'fixture-session'}}],
  ['principal incoerente', call(C), 'TOOL_AUTHORIZATION_DENIED', {[C]: {requiresPrincipal: true}}, {principal: null}],
  ['capability incoerente', call(C), 'TOOL_CAPABILITY_DENIED', {[C]: {capabilityId: 'facile.webcamgo.read'}}],
]) {
  test(`F6: secondo tool ${label} impedisce l'esecuzione del primo`, async () => {
    const f = fixture({[S]: {terminal: false, requiresPrincipal: false}, [C]: {terminal: false}, ...overrides})
    assertRejected(await f.run([call(S), invalid], options), f, code)
  })
}

test('F6: valida anche gli argomenti dopo un terminale, prima di qualsiasi esecuzione', async () => {
  const f = fixture()
  assertRejected(await f.run([call(P, {plan: 'DomAssLicBase'}), call(C, {latest: 'yes'})]), f, 'TOOL_VALIDATION_ERROR')
})

test('F6: preflight raccoglie gli errori di tutte le chiamate, con indice nel batch', async () => {
  const f = fixture({[S]: {terminal: false}})
  const result = await f.run([call(S), call('unknown_tool'), call(C, '{invalid')])
  assertRejected(result, f, 'TOOL_UNAVAILABLE', 3)
  assert.deepEqual(result.response.meta.toolErrors.map(error => [error.callIndex, error.code]),
    [[1, 'TOOL_UNAVAILABLE'], [2, 'INVALID_TOOL_ARGUMENTS']])
})

for (const calls of [[call(S), migration], [migration, call(S)], [migration, migration],
  [call(S), general.tool_calls[0]]]) {
  test(`F6: control deve essere esclusivo: ${calls.map(c => c.function.name).join(',')}`, async () => {
    const f = fixture({[S]: {terminal: false}})
    assertRejected(await f.run(calls), f, 'AGENT_MIGRATION_CONFLICT')
    assert.equal(f.requests.length, 1)
  })
}

test('F6: due read non terminali validi vengono entrambi eseguiti e restituiti al modello', async () => {
  const f = fixture({[S]: {terminal: false}, [C]: {terminal: false}})
  const result = await f.run([call(S, {expiresYear: 2026}), call(C, {latest: true})])
  assert.equal(result.outcome, 'HANDLED')
  assert.deepEqual(f.executions.map(item => item.name), [S, C])
  assert.deepEqual(result.response.meta.toolCalls.map(item => item.name), [S, C])
  assert.equal(result.response.meta.toolErrors, undefined)
  const toolResults = f.requests[1].messages.filter(item => item.role === 'tool')
  assert.deepEqual(toolResults.map(item => item.tool_name), [S, C])
  assert.deepEqual(toolResults.map(item => JSON.parse(item.content).args), [{expiresYear: 2026}, {latest: true}])
})

test('F6: sibling refine non eredita i filtri prodotti da una chiamata dello stesso batch', async () => {
  const f = fixture({[S]: {terminal: false}})
  const history = [{role: 'assistant', meta: {agentState: {tool: S, moduleId: 'facile.renewals',
    args: {customerOrGroup: 'Zilio Group', expiresYear: 2025}}}}]
  const result = await f.run([call(S, {expiresYear: 2026}), call(S, {dontRenewMode: 'exclude'})], {history})
  assert.equal(result.outcome, 'HANDLED')
  assert.deepEqual(f.executions.map(item => item.args), [
    {customerOrGroup: 'Zilio Group', expiresYear: 2026},
    {customerOrGroup: 'Zilio Group', expiresYear: 2025, dontRenewMode: 'exclude'},
  ])
})

for (const failure of ['throw', 'ok-false']) {
  test(`F6: esecuzione parziale ${failure} è ERROR, interrompe il resto e non presenta dati parziali`, async () => {
    const f = fixture({[S]: {terminal: false}, [C]: {terminal: false}, [P]: {terminal: false}})
    f.tools.find(tool => tool.name === C).execute = async () => {
      f.executions.push({name: C})
      if (failure === 'throw') throw new Error('PRIVATE_UPSTREAM_DETAIL')
      return {ok: false, data: {type: 'unverified'}}
    }
    const result = await f.run([call(S), call(C), call(P, {plan: 'Aruba-pecprem'})], {}, [batch([migration])])
    assert.equal(result.outcome, 'ERROR')
    assert.deepEqual(f.executions.map(item => item.name), [S, C])
    assert.equal(result.response.meta.toolErrors[0].code, 'TOOL_EXECUTION_ERROR')
    assert.equal(result.response.meta.toolBatch.status, 'failed')
    assert.equal(result.response.meta.toolBatch.requested, 3)
    assert.equal(result.response.meta.toolBatch.attempted, 2)
    assert.equal(result.response.meta.toolBatch.completed, 1)
    assert.equal(result.response.meta.agentState, undefined)
    assert.equal(result.response.data.type, 'tool-error')
    assert.equal(f.requests.length, 1, 'Non recupera un errore di batch tramite legacy')
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_UPSTREAM_DETAIL|Risultato verificato/)
  })
}

test('F6: errore del primo read non esegue gli altri', async () => {
  const f = fixture({[S]: {terminal: false}, [C]: {terminal: false}})
  f.tools[0].execute = async () => {f.executions.push({name: S}); throw new Error('PRIVATE_FIRST_FAILURE')}
  const result = await f.run([call(S), call(C)])
  assert.equal(result.outcome, 'ERROR')
  assert.deepEqual(f.executions.map(item => item.name), [S])
  assert.equal(result.response.meta.toolBatch.attempted, 1)
  assert.equal(result.response.meta.toolBatch.completed, 0)
})

test('F6: preflight non sostituisce il gate policy prima dell’esecuzione', async () => {
  const f = fixture({[S]: {terminal: false}, [C]: {terminal: false}})
  const original = f.tools[0].execute
  f.tools[0].execute = async args => {f.tools[2].risk = 'high'; return original(args)}
  const result = await f.run([call(S), call(C)])
  assert.equal(result.outcome, 'ERROR')
  assert.deepEqual(f.executions.map(item => item.name), [S])
  assert.equal(result.response.meta.toolErrors[0].code, 'TOOL_POLICY_DENIED')
  assert.equal(result.response.meta.toolBatch.attempted, 1)
})

test('F6: terminale singolo conserva risultato, stato e numero di inferenze', async () => {
  const f = fixture()
  const result = await f.run([call(P, {plan: 'Aruba-pecprem'})])
  assert.equal(result.outcome, 'HANDLED')
  assert.equal(result.response.meta.terminalTool, P)
  assert.equal(result.response.meta.agentState.args.plan, 'Aruba-pecprem')
  assert.equal(result.response.meta.toolBatch, undefined)
  assert.equal(f.requests.length, 1)
  assert.equal(f.executions.length, 1)
})

test('F6: anche l’ingresso executeGlobalConversation rifiuta batch terminali', async () => {
  const f = fixture()
  const result = await executeGlobalConversation({message: 'Due dettagli', credentials, principal,
    listTools: () => f.tools,
    callModel: async () => batch([call(P, {plan: 'DomAssLicBase'}), call(P, {plan: 'Aruba-pecprem'})])})
  assert.equal(result.ok, false)
  assert.equal(result.meta.toolErrors[0].code, 'AGENT_TERMINAL_BATCH_UNSUPPORTED')
  assert.equal(f.executions.length, 0)
})

test('F6: batch, policy, stato e inferenza invariati; solo protocollo control autorizzato da F7', () => {
  const path = 'src/core/orchestrator/globalConversation.js'
  const current = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  const previous = execFileSync('git', ['show', `HEAD:${path}`], {encoding: 'utf8'})
  for (const [start, end] of [
    ['function normalizeHistory(', 'function compactAssistantMessage('],
    ['  const allRegisteredTools = listTools(', '  const outcomeControl ='],
    ['  const stateHint = previousAgentState', '  const executedTools = []'],
    ['    const stateMessage = await callModel(', "    const timing = {stage: 'state'"],
    ["  const queryContext = ['refine', 'switch']", '  const migrationInstruction ='],
    ["        'Negli argomenti dei tool", '  let currentAgentState = previousAgentState'],
    ['    const assistantMessage = await callModel(', '    const modelDurationMs ='],
    ['    const batchStartedAt = executedTools.length', '    messages.push(compactAssistantMessage(assistantMessage))'],
    ['        const {args, stateMode, effectiveArgs}', '  return {\n    ok: false,\n    intent:'],
  ]) {
    const section = source => {
      const first = source.indexOf(start), last = source.indexOf(end, first)
      assert.ok(first >= 0 && last > first, `Model-facing section must exist: ${start}`)
      return source.slice(first, last)
    }
    assert.equal(section(current), section(previous), `F6 may not alter model-facing content: ${start}`)
  }
})
