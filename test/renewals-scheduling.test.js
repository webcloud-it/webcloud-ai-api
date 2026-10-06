import test from 'node:test'
import assert from 'node:assert/strict'
import {describeScheduledSend, readScheduling, renewalsSchedulingTool} from '../src/modules/facile/renewals/scheduling.js'
import {assertToolSchema} from '../src/core/tools/toolContract.js'
import {renewalsTools} from '../src/modules/facile/renewals/tools.js'
import http from 'node:http'
import {once} from 'node:events'
import {env} from '../src/config/env.js'
import {executeGlobalConversation} from '../src/core/orchestrator/globalConversation.js'

const cycleId = '10000000-0000-4000-8000-000000000001'
const mismatch = {status: 'mismatch', services: [{serviceId: 's', serviceName: 's.test',
  commercialCustomerId: 'A', commercialCustomerName: 'Cliente A', currentCommercialCustomerId: 'B', currentCommercialCustomerName: 'Cliente B'}]}
test('AI explains A to B using frozen and current commercial identity even for a stopped cycle', () => {
  const text = describeScheduledSend({status: 'cancelled', cycleStatus: 'stopped', commercialValidity: {status: 'stopped'}, blockedCommercialContext: mismatch})
  assert.match(text, /preparato per Cliente A.*commercialmente a Cliente B/)
  assert.doesNotMatch(text, /operativo/)
  assert.match(describeScheduledSend({status: 'blocked', commercialValidity: {status: 'unverifiable'}}), /non dimostrabili.*bloccato/)
  assert.match(describeScheduledSend({status: 'sent', commercialValidity: mismatch}), /già effettuato/)
  assert.match(describeScheduledSend({status: 'sent', historySynced: false}), /già inviata.*soltanto lo storico.*senza un nuovo invio/)
})
test('AI reads schedules and paged cycle operations with server-side cycle filter; never writes or sends', async () => {
  const paths = []
  const result = await readScheduling({cycleId, scope: 'Cliente A', page: 2}, {read: async path => {
    paths.push(path)
    return path.includes('/operations') ? {total: 1, page: 2, sends: [{cycle_id: cycleId, status: 'blocked', commercialValidity: mismatch}]} : [{id: 'schedule', customer_id: 'B'}]
  }})
  assert.equal(paths.length, 2); assert.ok(paths[0].includes('cycleId=' + cycleId))
  assert.equal(result.schedules[0].customer_id, 'B'); assert.equal(result.sends.length, 1)
  assert.match(result.sends[0].explanation, /Cliente A.*Cliente B/)
  assert.match(result.note, /regola futura.*preparazione congelata/)
  await assert.rejects(() => readScheduling({cycleId: 'invalid'}, {read: () => assert.fail()}), /Filtri/)
})
test('scheduling tool is registered with existing read capability and a valid contract', () => {
  assert.equal(renewalsTools.find(t => t.name === 'renewals_read_scheduling'), renewalsSchedulingTool)
  assertToolSchema(renewalsSchedulingTool.definition.function.parameters)
  assert.equal(renewalsSchedulingTool.mode, 'read'); assert.equal(renewalsSchedulingTool.capabilityId, 'facile.renewals.read')
})
test('registered AI scheduling tool explains the blocked commercial offer through real local HTTP reads', async () => {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({method: req.method, url: req.url})
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.url.startsWith('/services/renewals-scheduler/operations') ? {
      total: 1, sends: [{cycle_id: cycleId, scheduleName: 'Annuale', scopeName: 'Cliente A', status: 'blocked', cycleStatus: 'active', commercialValidity: mismatch}],
    } : [{id: 'schedule', customer_id: 'B'}]))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const original = env.renewalsApiBaseUrl
  env.renewalsApiBaseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const result = await renewalsSchedulingTool.execute({cycleId})
    assert.match(result.reply, /Cliente A.*commercialmente a Cliente B/)
    assert.equal(result.modelContent.sends[0].commercialValidity.status, 'mismatch')
    const agent = await executeGlobalConversation({
      message: 'Perché questa offerta programmata non è stata inviata?',
      credentials: {crm: 'validated-session'}, principal: {id: 'operator-1', roleId: null, roleName: null, source: 'crm'},
      listTools: () => renewalsTools,
      callModel: async request => request.format ? {content: JSON.stringify({stateMode: 'refine', entityReference: ''})} :
        {role: 'assistant', content: '', tool_calls: [{function: {name: renewalsSchedulingTool.name, arguments: {cycleId}}}]},
    })
    assert.equal(agent.ok, true); assert.equal(agent.source, 'agent')
    assert.equal(agent.data.sends[0].commercialValidity.status, 'mismatch')
    assert.equal(requests.length, 4); assert.ok(requests.every(r => r.method === 'GET'))
  } finally {
    env.renewalsApiBaseUrl = original; server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
})
