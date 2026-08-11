import test from 'node:test'
import assert from 'node:assert/strict'

import {handleWebcloudChat} from '../src/modules/facile/webcloud/chat.js'
import {getOperationalOverview} from '../src/modules/facile/webcloud/operationalOverview.js'

function services(overrides = {}) {
  return {
    getCloudflareBuckets: async () => ({items: [], total: 0}),
    getHolidays: async () => ({items: [], total: 0}),
    getAutomations: async () => ({items: [], total: 0}),
    getWamApplications: async () => ({items: [], total: 0}),
    getWamAssets: async () => ({items: [], total: 0}),
    getOperationalOverview: async () => ({sources: [], alerts: [], availableSources: 0, unavailableSources: 0}),
    ...overrides,
  }
}

test('lists Cloudflare cache buckets without offering a mutation', async () => {
  const result = await handleWebcloudChat({
    message: 'Mostrami la cache Cloudflare', credentials: {crm: 'crm-token'},
    services: services({getCloudflareBuckets: async () => ({items: [{name: 'asiago', timestamp: 1}], total: 1})}),
  })
  assert.equal(result.intent, 'webcloud-cache-buckets')
  assert.equal(result.data.actions[0].path, '/webcloud/cloudflare-cache')
  assert.equal(JSON.stringify(result).includes('clear'), false)
})

test('apre direttamente una sezione Webcloud esplicita', async () => {
  const result = await handleWebcloudChat({
    message: 'apri la cache Cloudflare', credentials: {crm: 'crm-token'}, services: services(),
  })
  assert.equal(result.intent, 'app-action')
  assert.equal(result.data.appAction.path, '/webcloud/cloudflare-cache')
})

test('lists holidays using the CRM credential', async () => {
  let token = null
  const result = await handleWebcloudChat({
    message: 'Quali sono le prossime festività?', credentials: {crm: 'crm-token'},
    services: services({getHolidays: async options => {
      token = options.token
      return {items: [{id: 1, name: 'Ferragosto', type: 'festività', from: '2026-08-15', to: '2026-08-15'}], total: 1}
    }}),
  })
  assert.equal(token, 'crm-token')
  assert.match(result.reply, /Ferragosto/)
})

test('sanitizes automation results and uses the Nozomi credential', async () => {
  const result = await handleWebcloudChat({
    message: 'Elenca le automazioni', credentials: {nozomi: 'nozomi-token'},
    services: services({getAutomations: async () => ({items: [{id: 'a1', name: 'Pubblica', runnable: true, inputs: [{name: 'Titolo'}]}], total: 1})}),
  })
  assert.equal(result.intent, 'webcloud-automations')
  assert.equal(JSON.stringify(result).includes('nozomi-token'), false)
})

test('apre un’automazione univoca e propone quelle ambigue', async () => {
  const unique = await handleWebcloudChat({
    message: 'apri automazione Pubblica', credentials: {nozomi: 'nozomi-token'},
    services: services({getAutomations: async () => ({items: [{id: 'a1', name: 'Pubblica', runnable: true, inputs: []}], total: 1})}),
  })
  assert.equal(unique.intent, 'app-action')
  assert.equal(unique.data.appAction.path, '/webcloud/mattemations/a1')

  const ambiguous = await handleWebcloudChat({
    message: 'apri automazione Pubblica', credentials: {nozomi: 'nozomi-token'},
    services: services({getAutomations: async () => ({items: [
      {id: 'a1', name: 'Pubblica Asiago', runnable: true, inputs: []},
      {id: 'a2', name: 'Pubblica WebcamGo', runnable: true, inputs: []},
    ], total: 2})}),
  })
  assert.equal(ambiguous.intent, 'webcloud-automations-open-ambiguous')
  assert.equal(ambiguous.data.items.length, 2)
})

test('fails closed when the WAM credential is missing', async () => {
  const result = await handleWebcloudChat({message: 'Cerca asset WAM', credentials: {}, services: services()})
  assert.equal(result.intent, 'unavailable')
  assert.equal(result.data.credential, 'wam')
})

test('apre un asset WAM univoco mantenendo il riferimento applicazione', async () => {
  const result = await handleWebcloudChat({
    message: 'apri asset Logo estate', credentials: {wam: 'wam-token'},
    services: services({getWamAssets: async () => ({items: [{id: 'asset-1', shortId: 'logo-estate', title: 'Logo estate', applicationId: 'app-1'}], total: 1})}),
  })
  assert.equal(result.intent, 'app-action')
  assert.equal(result.data.appAction.path, '/webcloud/assets-manager/app-1/assets')
  assert.deepEqual(result.data.appAction.query, {asset: 'logo-estate'})
})

test('reports chatbot operational health without calling an external service', async () => {
  const result = await handleWebcloudChat({message: 'Mostrami lo stato del chatbot', credentials: {crm: 'crm-token'}, services: services()})
  assert.equal(result.intent, 'webcloud-chat-audit')
  assert.equal(result.data.type, 'webcloud-chat-audit')
  assert.equal(JSON.stringify(result).includes('crm-token'), false)
})

test('builds a partial operational overview without failing unavailable areas', async () => {
  const result = await getOperationalOverview({
    credentials: {crm: 'crm-token', webcamgo: 'webcam-token'},
    services: {
      renewalsSource: async () => ({id: 'renewals', label: 'Rinnovi', ok: true, metrics: {urgent: 2}, alerts: [{level: 'high', label: '2 rinnovi urgenti'}]}),
      webcamSource: async token => ({id: 'webcamgo', label: 'WebcamGo', ok: token === 'webcam-token', metrics: {unexpectedOffline: 0}, alerts: []}),
      sendInItalySource: async () => { throw new Error('non deve essere chiamato') },
      chatbotSource: () => ({id: 'chatbot', label: 'Chatbot', ok: true, metrics: {failures: 0}, alerts: []}),
    },
  })
  assert.equal(result.availableSources, 3)
  assert.equal(result.unavailableSources, 1)
  assert.equal(result.alerts[0].label, '2 rinnovi urgenti')
})

test('answers global operational overview requests', async () => {
  const result = await handleWebcloudChat({
    message: 'Ci sono problemi?', credentials: {crm: 'crm-token'},
    services: services({getOperationalOverview: async () => ({sources: [{id: 'renewals', label: 'Rinnovi', ok: true, metrics: {urgent: 1}, alerts: [{level: 'high', label: '1 rinnovo urgente'}]}], alerts: [{level: 'high', label: '1 rinnovo urgente'}], availableSources: 1, unavailableSources: 3})}),
  })
  assert.equal(result.intent, 'webcloud-operational-overview')
  assert.match(result.reply, /1 criticità alte/)
})
