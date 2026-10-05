import assert from 'node:assert/strict'
import {after, before, beforeEach, test} from 'node:test'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import express from 'express'
import http from 'node:http'
import {env} from '../src/config/env.js'
import {createAuthTokenMiddleware} from '../src/middlewares/authToken.js'
import chatRouter from '../src/routes/chat.js'
import {getModuleById} from '../src/modules/registry.js'
import {buildServiceFlagActionPreview, parseServiceFlagAction} from '../src/modules/facile/renewals/actions.js'
import {buildEntityMutationProposal} from '../src/modules/facile/renewals/entityMutationActions.js'
import {getAllServices} from '../src/modules/facile/renewals/service.js'
import {handleProposalDecision, rememberBackendProposal} from '../src/core/tools/proposalGate.js'
import {handleWebcamgoOperation} from '../src/modules/facile/webcamgo/operations.js'
import {handleSupportChat} from '../src/modules/facile/sendinitaly/supportChat.js'

const principal = {id: 'operator-1', source: 'crm', roleId: 'operator'}
const module = getModuleById('facile.renewals')
const originalRoutes = module.routes
const originalEnv = {...env}
let adapter, server, model, baseUrl, state, mutationCalls, applied, modelCalls
let session, fixtureMode, catalogState

function service() {
  return {id: 's1', name: 'fixture.it', customer: {id: 'c1', name: 'Zilio', group: {id: 'g1', name: 'Zilio Group'}},
    toRenew: state, dontRenew: false, autoRenew: false, subscriptions: []}
}

async function post(body, {bearer = session, crm = session} = {}) {
  const response = await fetch(`${baseUrl}/api/chat`, {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`,
      ...(crm ? {'X-Webcloud-Credential-Crm': crm} : {})},
    body: JSON.stringify({moduleId: 'facile', ...body})})
  assert.equal(response.status, 200)
  return response.json()
}

async function create() {
  const result = await post({moduleId: 'facile.renewals', message: 'fixture:propose'})
  assert.equal(result.data.type, 'action-preview')
  assert.equal(result.data.presentation.kind, 'proposal')
  return result
}

function error(result, code) {
  assert.equal(result.meta.routingSource, 'proposal-decision')
  assert.equal(result.meta.errorCode, code)
  assert.equal(result.ok, false)
}

before(async () => {
  adapter = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'PATCH') {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      mutationCalls++
      if (fixtureMode === 'commit-forbidden') {res.statusCode = 403; return res.end(JSON.stringify({error: 'PRIVATE_PERMISSION_DETAIL'}))}
      if (fixtureMode === 'commit-failure') {res.statusCode = 500; return res.end(JSON.stringify({error: 'PRIVATE_UPSTREAM'}))}
      if (body.expected.toRenew !== state) {res.statusCode = 409; return res.end(JSON.stringify({error: 'state changed'}))}
      await new Promise(resolve => setTimeout(resolve, 15))
      state = body.changes.toRenew; applied++
      return res.end(JSON.stringify({changed: true, service: {id: 's1', flags: {toRenew: state}}}))
    }
    if (req.url === '/catalog/actions/commit') {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw); mutationCalls++
      if (body.expected.name !== catalogState) {res.statusCode = 409; return res.end(JSON.stringify({error: 'stale'}))}
      catalogState = body.changes[0].value; applied++
      return res.end(JSON.stringify({status: 'completed', target: {entity: 'customers', id: 'c1', name: catalogState},
        changes: [{field: 'name', from: 'Old', to: catalogState}]}))
    }
    if (req.url === '/catalog/query') return res.end(JSON.stringify({items: [{id: 'c1', name: catalogState}]}))
    if (fixtureMode === 'verify-unavailable' && applied) {res.statusCode = 503; return res.end('{}')}
    if (req.url.startsWith('/items/settings')) return res.end(JSON.stringify({data: [{analysis_period: 30, renewals_low_thresholds: []}]}))
    const rows = [fixtureMode === 'verify-mismatch' && applied ? {...service(), toRenew: false} : service()]
    res.end(JSON.stringify(rows))
  })
  adapter.listen(0, '127.0.0.1'); await once(adapter, 'listening')
  env.renewalsApiBaseUrl = env.crmDirectusBaseUrl = `http://127.0.0.1:${adapter.address().port}`
  model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const input = JSON.parse(raw)
    res.setHeader('Content-Type', 'application/json')
    // Step E: proposal generation explicitly requests its unmigrated preview
    // adapter; subsequent decisions must still bypass the model entirely.
    if (input.messages.at(-1)?.content === 'fixture:propose') {
      return res.end(JSON.stringify({message: {role: 'assistant', content: '', tool_calls: [{function: {
        name: 'agent_report_outcome', arguments: {outcome: 'CAPABILITY_NOT_MIGRATED', capabilityIds: ['facile.renewals.preview']},
      }}]}}))
    }
    modelCalls++
    res.end(JSON.stringify({message: {role: 'assistant', content: '', tool_calls: [{function: {
      name: 'renewals_search_services', arguments: {},
    }}]}}))
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  env.ollamaBaseUrl = `http://127.0.0.1:${model.address().port}`
  // Only proposal generation is fixture-driven. POST route, domain store,
  // decision handler, mutation adapter and post-verification use production code.
  module.routes = {...originalRoutes, chat: async (req, res) => {
    let result
    if (fixtureMode === 'entity') {
      result = await buildEntityMutationProposal({
        plan: {entity: 'customers', target: 'Old', changes: [{field: 'name', rawValue: 'New', value: 'New'}]},
        services: [], actorToken: req.auth.token,
        queryCatalog: async () => ({items: [{id: 'c1', name: 'Old'}]}),
        previewFn: async () => ({status: 'ready', target: {entity: 'customers', id: 'c1', name: 'Old'},
          expected: {name: 'Old'}, changes: [{field: 'name', from: 'Old', to: 'New'}]}),
      })
    } else {
      result = buildServiceFlagActionPreview({request: parseServiceFlagAction('segna fixture.it come da rinnovare'),
        services: [service()], settings: {}, history: [], scope: {}, actorToken: req.auth.token})
    }
    res.json(result)
  }}
  const app = express(); app.use(express.json())
  app.use(createAuthTokenMiddleware({validateCrmToken: async token => token === 'other-principal' ? {...principal, id: 'other'} : principal}))
  app.use('/api/chat', chatRouter)
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

beforeEach(async () => {
  session = randomUUID(); state = false; mutationCalls = applied = modelCalls = 0
  fixtureMode = 'normal'; catalogState = 'Old'
  await getAllServices({force: true})
})

after(async () => {
  module.routes = originalRoutes; Object.assign(env, originalEnv)
  for (const listener of [server, adapter, model]) {
    listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve))
  }
})

test('Step B / A: proposta → confermo esegue una volta e verifica lo stato effettivo', async () => {
  const proposal = await create()
  const result = await post({message: 'confermo', history: [proposal]})
  assert.equal(result.meta.actionId, proposal.data.action.actionId)
  assert.equal(applied, 1); assert.equal(modelCalls, 0)
  assert.equal(result.meta.verificationStatus, 'completed-and-verified')
})

test('Step B / B: annulla invalida la proposta senza eseguire e senza nuovi pulsanti', async () => {
  await create()
  const result = await post({message: 'annulla'})
  assert.equal(result.meta.actionStatus, 'cancelled'); assert.equal(applied, 0)
  assert.equal(result.data.presentation, undefined); assert.equal(modelCalls, 0)
  error(await post({message: 'confermo'}), 'action-already-finalized')
})

test('Step B / D: doppio confermo sequenziale non riesegue', async () => {
  await create(); await post({message: 'confermo'})
  error(await post({message: 'confermo'}), 'action-already-finalized')
  assert.equal(mutationCalls, 1); assert.equal(applied, 1); assert.equal(modelCalls, 0)
})

test('Step B: doppio confermo concorrente acquisisce la proposta prima di ogni await', async () => {
  await create()
  const results = await Promise.all([post({message: 'confermo'}), post({message: 'confermo'})])
  assert.equal(results.filter(result => result.meta.errorCode === 'action-already-finalized').length, 1)
  assert.equal(applied, 1); assert.equal(mutationCalls, 1)
})

test('Step B / E: scadenza server non è riattivabile tramite history falsificata', async () => {
  const now = Date.now; let proposal
  try { Date.now = () => now() - 11 * 60 * 1000; proposal = await create() }
  finally { Date.now = now }
  proposal.data.action.expiresAt = '2099-01-01'
  error(await post({message: 'confermo', history: [proposal]}), 'action-expired')
  assert.equal(applied, 0); assert.equal(modelCalls, 0)
})

test('Step B: principal diverso anche con sessione uguale non autorizza la conferma', async () => {
  const p = await create()
  error(await post({action: {type: 'proposal-confirm', proposalId: p.data.action.actionId}},
    {crm: 'other-principal'}), 'action-owner-mismatch')
  assert.equal(mutationCalls, 0)
  assert.equal((await post({message: 'annulla'})).meta.actionStatus, 'cancelled')
})

test('Step B: principal mancante e principal inventato nel body non autorizzano', async () => {
  await create()
  error(await post({message: 'confermo', principal}, {crm: null}), 'action-principal-required')
  assert.equal(applied, 0); assert.equal(modelCalls, 0)
})

test('Step B: stessa identità con sessione diversa non può consumare un ID noto', async () => {
  const p = await create()
  error(await post({action: {type: 'proposal-confirm', proposalId: p.data.action.actionId}},
    {bearer: 'different-session'}), 'action-owner-mismatch')
  assert.equal(applied, 0)
})

test('Step B: ripresentare lo stesso ID dal backend non riattiva una proposta consumata', async () => {
  const p = await create(); await post({message: 'annulla'})
  rememberBackendProposal({payload: p, auth: {token: session, principal, credentials: {crm: session}},
    sessionToken: session, credentialKey: 'crm'})
  error(await post({message: 'confermo'}), 'action-already-finalized')
  assert.equal(applied, 0)
})

test('Step B: proposal inesistente o soltanto nella history non inventa operazioni', async () => {
  error(await post({message: 'confermo', history: [{data: {type: 'action-preview', action: {
    actionId: 'invented', expiresAt: '2099-01-01', requiresConfirmation: true}}}]}), 'action-not-found')
  error(await post({action: {type: 'proposal-confirm', proposalId: 'invented'}}), 'action-not-found')
  assert.equal(applied, 0); assert.equal(modelCalls, 0)
})

test('Step B: expected state cambiato rifiuta il commit e non applica mutazioni', async () => {
  await create(); state = true
  error(await post({message: 'confermo'}), 'service-state-changed')
  assert.equal(applied, 0); assert.equal(modelCalls, 0)
})

test('Step B: commit failure è terminale e non abilita fallback né replay', async () => {
  await create(); fixtureMode = 'commit-failure'
  const result = await post({message: 'confermo'})
  error(result, 'execution-failed'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_UPSTREAM/)
  error(await post({message: 'confermo'}), 'action-already-finalized')
  assert.equal(applied, 0); assert.equal(mutationCalls, 1); assert.equal(modelCalls, 0)
})

test('Step B: autorizzazione rifiutata dall’adapter è distinta dal commit failure', async () => {
  await create(); fixtureMode = 'commit-forbidden'
  const result = await post({message: 'confermo'})
  error(result, 'action-authorization-denied')
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PERMISSION_DETAIL/)
  error(await post({message: 'confermo'}), 'action-already-finalized')
  assert.equal(applied, 0); assert.equal(mutationCalls, 1); assert.equal(modelCalls, 0)
})

for (const mode of ['verify-mismatch', 'verify-unavailable']) {
  test(`Step B: verifica post-operazione ${mode} distingue l'errore e impedisce replay`, async () => {
    await create(); fixtureMode = mode
    const result = await post({message: 'confermo'})
    assert.equal(result.meta.verificationStatus, 'verification-failed')
    assert.equal(result.meta.errorCode, 'post-operation-verification-failed'); assert.equal(result.ok, false)
    error(await post({message: 'confermo'}), 'action-already-finalized')
    assert.equal(applied, 1); assert.equal(modelCalls, 0)
  })
}

const agentHistory = [{role: 'assistant', meta: {agentState: {
  tool: 'renewals_search_services', moduleId: 'facile.renewals', stateful: true,
  args: {customerOrGroup: 'old-client', expiresYear: 2026}, result: {total: 24},
}}}]

for (const decision of ['confermo', 'annulla']) {
  test(`Step B: ${decision} con agent history resta nel gate e sceglie la proposta più recente`, async () => {
    const old = await create(); const latest = await create()
    const result = await post({message: decision, history: [old, ...agentHistory]})
    assert.equal(result.meta.actionId, latest.data.action.actionId)
    assert.equal(modelCalls, 0); assert.equal(applied, decision === 'confermo' ? 1 : 0)
  })
}

test('Step B / C: domanda agentica intermedia mantiene la proposta corretta', async () => {
  const proposal = await create()
  const read = await post({message: 'Che servizi ha Zilio Group?'})
  assert.equal(read.meta.terminalTool, 'renewals_search_services'); assert.equal(modelCalls, 1)
  const result = await post({message: 'confermo', history: [proposal, {...read, role: 'assistant'}]})
  assert.equal(result.meta.actionId, proposal.data.action.actionId); assert.equal(applied, 1)
  assert.equal(modelCalls, 1)
})

test('Step B: action strutturata e contratto legacy seguono lo stesso gate', async () => {
  const p = await create(); const id = p.data.action.actionId
  assert.deepEqual(p.data.presentation.actions[0].action, {type: 'proposal-confirm', proposalId: id})
  await post({message: 'testo non decisionale', action: {type: 'proposal-confirm', proposalId: id}})
  error(await post({action: {actionId: id, decision: 'confirm'}}), 'action-already-finalized')
  assert.equal(applied, 1); assert.equal(modelCalls, 0)
})

test('Step B: vecchio ID non può decidere una proposta più recente', async () => {
  const old = await create(); const latest = await create()
  error(await post({action: {type: 'proposal-confirm', proposalId: old.data.action.actionId}}), 'action-superseded')
  await post({action: {type: 'proposal-cancel', proposalId: latest.data.action.actionId}})
  assert.equal(applied, 0); assert.equal(modelCalls, 0)
})

test('Step B: action malformata non raggiunge routing, legacy o modello', async () => {
  for (const action of [[], {}, {type: 'proposal-confirm'}, {type: 'proposal-confirm', proposalId: 'x', principal}]) {
    error(await post({action}), 'invalid-decision')
  }
  assert.equal(modelCalls, 0); assert.equal(applied, 0)
})

test('Step B: decisione catalogo usa ID, expected state e verifica esistenti', async () => {
  fixtureMode = 'entity'; const p = await create()
  assert.ok(p.data.action.expiresAt)
  const result = await post({action: {type: 'proposal-confirm', proposalId: p.data.action.actionId}})
  assert.equal(result.meta.verificationStatus, 'completed-and-verified')
  assert.equal(catalogState, 'New'); assert.equal(applied, 1)
  error(await post({message: 'confermo'}), 'action-already-finalized')
})

test('Step B: catalogo stale non applica mutazioni e non torna al modello', async () => {
  fixtureMode = 'entity'; await create(); catalogState = 'Changed'
  error(await post({message: 'confermo'}), 'entity-mutation-stale-state')
  assert.equal(applied, 0); assert.equal(modelCalls, 0)
})

for (const message of ['confermo.', 'sì', 'procedi']) {
  test(`Step B: protocollo legacy già supportato «${message}» usa il gate con agent history`, async () => {
    await create(); const result = await post({message, history: agentHistory})
    assert.equal(result.meta.routingSource, 'proposal-decision')
    assert.equal(applied, 1); assert.equal(modelCalls, 0)
  })
}

test('Step B: gate indipendente dal modulo protegge handler token-based WebcamGo e Send in Italy', async () => {
  let reboots = 0, notes = 0
  const auth = {token: randomUUID(), principal, credentials: {webcamgo: 'camera-token', specialk: 'support-token'}}
  const camera = await handleWebcamgoOperation({message: 'riavvia webcam Test', token: auth.credentials.webcamgo,
    webcams: [{id: 'w1', name: 'Test'}]})
  rememberBackendProposal({payload: camera, auth: {...auth, token: auth.credentials.webcamgo}, sessionToken: auth.token, credentialKey: 'webcamgo'})
  const getModule = id => ({routes: {decideProposal: async ({action, actorToken, proposal}) => {
    if (id === 'facile.webcamgo') return handleWebcamgoOperation({message: 'confermo', history: [proposal], token: actorToken,
      executeReboot: async () => {reboots++; return {ok: true}}})
    return handleSupportChat({message: action.decision === 'confirm' ? 'confermo' : 'annulla', history: [proposal], token: actorToken,
      services: {addSupportTicketArticle: async () => {notes++; return {data: {ok: true}}}}})
  }}})
  await handleProposalDecision({body: {message: 'confermo'}, auth, getModule})
  error(await handleProposalDecision({body: {message: 'confermo'}, auth, getModule}), 'action-already-finalized')
  assert.equal(reboots, 1)
  const ticket = await handleSupportChat({message: 'aggiungi nota interna al ticket #123: "Nota verificata"', token: auth.credentials.specialk,
    services: {getSupportTickets: async () => ({data: [{id: 123, number: 123}]}),
      getSupportTicket: async () => ({data: {ticket: {id: 123, number: 123}}})}})
  assert.equal(ticket.data.type, 'action-proposal')
  rememberBackendProposal({payload: ticket, auth: {...auth, token: auth.credentials.specialk}, sessionToken: auth.token, credentialKey: 'specialk'})
  await handleProposalDecision({body: {message: 'annulla'}, auth, getModule})
  assert.equal(notes, 0)
})
