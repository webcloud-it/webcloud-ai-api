import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getAvailableModuleIds,
  getCapabilityCatalog,
} from '../src/core/capabilities/catalog.js'
import {planGlobalChat, resolveGlobalChatPlan} from '../src/core/orchestrator/globalChat.js'
import {contextualizeRenewalsMessage, getContextScope} from '../src/core/context/pageContext.js'

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
  assert.equal(plan.capabilities.length, 3)
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

test('global planner uses the active section for ambiguous business entities', () => {
  const sendPlan = planGlobalChat({
    message: 'Apri il cliente Acme',
    context: {section: 'sendinitaly.users', path: '/sendinitaly/users'},
    credentials: {...credentials, specialk: 'specialk-token'},
  })
  assert.equal(sendPlan.moduleId, 'facile.sendinitaly')
  assert.equal(sendPlan.source, 'context')

  const renewalsPlan = planGlobalChat({
    message: 'Apri il cliente Acme',
    context: {section: 'crm.renewals', path: '/crm/renewals/panel'},
    credentials,
  })
  assert.equal(renewalsPlan.moduleId, 'facile.renewals')
  assert.equal(renewalsPlan.source, 'context')
})

test('global planner gives local entity details precedence over ambiguous names', () => {
  const plan = planGlobalChat({
    message: 'dettagli di Asiago Piazza Carli',
    context: {
      section: 'webcamgo',
      path: '/webcamgo/webcams/asiago-piazza-carli',
      activeEntity: {type: 'webcam', slug: 'asiago-piazza-carli'},
    },
    credentials: {...credentials, cmsAsiagoIt: 'cms-token'},
  })

  assert.equal(plan.moduleId, 'facile.webcamgo')
  assert.equal(plan.source, 'active-entity')
})

test('global planner still honors an explicit foreign-domain request from an entity page', () => {
  const plan = planGlobalChat({
    message: 'mostrami i prossimi eventi di Asiago',
    context: {activeEntity: {type: 'webcam', slug: 'asiago-piazza-carli'}},
    credentials: {...credentials, cmsAsiagoIt: 'cms-token'},
  })

  assert.equal(plan.moduleId, 'facile.asiago')
  assert.equal(plan.source, 'message')
})

test('renewals scope accepts the typed active entity and legacy route query', () => {
  assert.deepEqual(
    getContextScope({activeEntity: {type: 'service', id: 'service-42'}}),
    {customerId: null, groupId: null, serviceId: 'service-42', webcamSlug: null}
  )
  assert.equal(getContextScope({query: {customerId: 'customer-7'}}).customerId, 'customer-7')
})

test('renewals contextual follow-ups are grounded to the active service', () => {
  const scope = {serviceId: 'service-42'}
  assert.equal(
    contextualizeRenewalsMessage('mostrami i dettagli', scope),
    'dettagli del servizio service-42'
  )
  assert.equal(
    contextualizeRenewalsMessage('e la scadenza?', scope),
    'qual è la scadenza cliente del servizio service-42'
  )
  assert.equal(
    contextualizeRenewalsMessage('rinnova questo servizio', scope),
    'rinnova questo servizio'
  )
})

test('global planner routes Cloudflare to the Webcloud tools module', () => {
  const plan = planGlobalChat({message: 'Pulisci la cache Cloudflare', credentials})

  assert.equal(plan.type, 'module')
  assert.equal(plan.moduleId, 'facile.webcloud')
})

test('a capability question stays at global help even when it names Cloudflare', () => {
  const plan = planGlobalChat({message: 'Cosa puoi fare su Cloudflare?', credentials})

  assert.equal(plan.type, 'help')
})

test('semantic router may select only an available catalog module', async () => {
  const plan = await resolveGlobalChatPlan(
    {message: 'Controlla se qualcosa non sta trasmettendo', credentials},
    async () => ({moduleId: 'facile.webcamgo', confidence: 0.91})
  )

  assert.equal(plan.type, 'module')
  assert.equal(plan.moduleId, 'facile.webcamgo')
  assert.equal(plan.source, 'semantic')
})

test('semantic router rejects invented or unavailable modules', async () => {
  const plan = await resolveGlobalChatPlan(
    {message: 'Controlla la situazione', credentials},
    async () => ({moduleId: 'facile.invented', confidence: 0.99})
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

test('global planner routes a natural minisite closing question to opening hours', () => {
  const plan = planGlobalChat({message: 'Quando chiude il minisito?', credentials: {...credentials, cmsAsiagoIt: 'cms-token'}})
  assert.equal(plan.type, 'module')
  assert.equal(plan.moduleId, 'facile.businesshours')
})

test('global planner routes Asiago events when the CMS credential is available', () => {
  const plan = planGlobalChat({
    message: 'Mostrami i prossimi eventi di Asiago',
    credentials: {...credentials, cmsAsiagoIt: 'cms-token'},
  })

  assert.equal(plan.type, 'module')
  assert.equal(plan.moduleId, 'facile.asiago')
})

test('global planner routes a generic minisite query to Asiago, not opening hours', () => {
  const plan = planGlobalChat({
    message: 'Cerca il minisito Hotel Europa',
    credentials: {...credentials, cmsAsiagoIt: 'cms-token'},
  })

  assert.equal(plan.type, 'module')
  assert.equal(plan.moduleId, 'facile.asiago')
})

test('global planner reports Asiago unavailable without the CMS credential', () => {
  const plan = planGlobalChat({message: 'Elenca gli eventi di Asiago', credentials})

  assert.equal(plan.type, 'unavailable')
  assert.equal(plan.moduleId, 'facile.asiago')
})

test('global planner routes snow bulletin, pricelists and redirects to Asiago', () => {
  const fullCredentials = {...credentials, cmsAsiagoIt: 'cms-token', snowbulletin: 'snow', spine01: 'spine', nozomi: 'nozomi'}
  for (const message of ['Controlla il bollettino neve', 'Elenca i listini', 'Cerca i redirect']) {
    const plan = planGlobalChat({message, credentials: fullCredentials})
    assert.equal(plan.type, 'module')
    assert.equal(plan.moduleId, 'facile.asiago')
  }
})

test('global planner routes assets, holidays and automations to Webcloud tools', () => {
  const fullCredentials = {...credentials, wam: 'wam', nozomi: 'nozomi'}
  for (const message of ['Cerca asset WAM', 'Mostra le prossime festività', 'Elenca le automazioni']) {
    const plan = planGlobalChat({message, credentials: fullCredentials})
    assert.equal(plan.type, 'module')
    assert.equal(plan.moduleId, 'facile.webcloud')
  }
})

test('global planner routes chatbot operational status to Webcloud tools', () => {
  const plan = planGlobalChat({message: 'Mostrami lo stato del chatbot', credentials})
  assert.equal(plan.type, 'module')
  assert.equal(plan.moduleId, 'facile.webcloud')
})

test('global planner routes an operational overview to Webcloud tools', () => {
  const plan = planGlobalChat({message: 'Ci sono problemi?', credentials})
  assert.equal(plan.type, 'module')
  assert.equal(plan.moduleId, 'facile.webcloud')
})
