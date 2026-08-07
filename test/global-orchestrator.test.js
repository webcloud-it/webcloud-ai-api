import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getAvailableModuleIds,
  getCapabilityCatalog,
} from '../src/core/capabilities/catalog.js'
import {planGlobalChat, resolveGlobalChatPlan} from '../src/core/orchestrator/globalChat.js'

const credentials = {crm: 'crm-token', webcamgo: 'webcamgo-token'}

test('capability catalog exposes only domains with a credential', () => {
  const capabilities = getCapabilityCatalog({credentials: {webcamgo: 'token'}})

  assert.deepEqual(getAvailableModuleIds({credentials: {webcamgo: 'token'}}), [
    'facile.webcamgo',
  ])
  assert.ok(capabilities.every(item => item.available === true))
  assert.ok(capabilities.every(item => item.credential === 'webcamgo'))
})

test('global planner routes an explicit webcam request from a CRM page', () => {
  const plan = planGlobalChat({
    message: 'Quali webcam hanno lo stream offline?',
    context: {section: 'crm.renewals', path: '/crm/renewals/panel'},
    credentials,
  })

  assert.equal(plan.type, 'module')
  assert.equal(plan.moduleId, 'facile.webcamgo')
  assert.equal(plan.source, 'message')
})

test('global planner routes an explicit renewals request from WebcamGo', () => {
  const plan = planGlobalChat({
    message: 'Mostrami i rinnovi in scadenza',
    context: {section: 'webcamgo', path: '/webcamgo/webcams'},
    credentials,
  })

  assert.equal(plan.type, 'module')
  assert.equal(plan.moduleId, 'facile.renewals')
  assert.equal(plan.source, 'message')
})

test('global planner uses structured history for a confirmation follow-up', () => {
  const plan = planGlobalChat({
    message: 'Confermo',
    context: {path: '/webcamgo/webcams'},
    history: [
      {
        role: 'assistant',
        content: 'Confermi questa operazione?',
        meta: {moduleId: 'facile.renewals'},
      },
    ],
    credentials,
  })

  assert.equal(plan.type, 'module')
  assert.equal(plan.moduleId, 'facile.renewals')
  assert.equal(plan.source, 'history')
})

test('global planner answers capability questions without loading a domain', () => {
  const plan = planGlobalChat({
    message: 'Cosa puoi fare?',
    credentials,
  })

  assert.equal(plan.type, 'help')
  assert.equal(plan.capabilities.length, 2)
})

test('global planner does not route a domain without its credential', () => {
  const plan = planGlobalChat({
    message: 'Riassumi le webcam offline',
    credentials: {crm: 'crm-token'},
  })

  assert.equal(plan.type, 'unavailable')
  assert.equal(plan.moduleId, 'facile.webcamgo')
})

test('global planner asks for the domain when the message and context are ambiguous', () => {
  const plan = planGlobalChat({
    message: 'Controlla la situazione',
    credentials,
  })

  assert.equal(plan.type, 'clarification')
  assert.equal(plan.reason, 'domain-required')
})

test('global planner keeps greetings at the global level', () => {
  const plan = planGlobalChat({message: 'Ciao!', credentials})

  assert.equal(plan.type, 'greeting')
})

test('global planner routes Send in Italy when its credential is available', () => {
  const plan = planGlobalChat({
    message: 'Mostrami le campagne di Send in Italy',
    credentials: {...credentials, specialk: 'specialk-token'},
  })

  assert.equal(plan.type, 'module')
  assert.equal(plan.moduleId, 'facile.sendinitaly')
})

test('global planner explicitly reports a known domain that is not onboarded yet', () => {
  const plan = planGlobalChat({message: 'Pulisci la cache Cloudflare', credentials})

  assert.equal(plan.type, 'unsupported-domain')
  assert.equal(plan.domain.id, 'cloudflare')
})

test('an unsupported named domain takes precedence over a generic capability question', () => {
  const plan = planGlobalChat({message: 'Cosa puoi fare su Cloudflare?', credentials})

  assert.equal(plan.type, 'unsupported-domain')
  assert.equal(plan.domain.id, 'cloudflare')
})

test('semantic router may select only an available catalog module', async () => {
  const plan = await resolveGlobalChatPlan(
    {message: 'Controlla se qualcosa non sta trasmettendo', credentials},
    async () => '{"moduleId":"facile.webcamgo","confidence":0.91}'
  )

  assert.equal(plan.type, 'module')
  assert.equal(plan.moduleId, 'facile.webcamgo')
  assert.equal(plan.source, 'semantic')
})

test('semantic router rejects invented or unavailable modules', async () => {
  const plan = await resolveGlobalChatPlan(
    {message: 'Controlla la situazione', credentials},
    async () => '{"moduleId":"facile.invented","confidence":0.99}'
  )

  assert.equal(plan.type, 'clarification')
})

test('global planner routes minisite opening hours', () => {
  const plan = planGlobalChat({
    message: 'Quali sono gli orari di apertura del minisito?',
    credentials: {...credentials, cmsAsiagoIt: 'cms-token'},
  })

  assert.equal(plan.type, 'module')
  assert.equal(plan.moduleId, 'facile.businesshours')
})
