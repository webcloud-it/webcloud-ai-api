import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPEN_EMAIL_GENERATION_ACTION_ID,
  buildOpenEmailGenerationAction,
  handlePendingOpenEmailGenerationClarification,
  hasPendingOpenEmailGenerationClarification,
  parseOpenEmailGenerationAction,
  resolveOpenEmailGenerationTarget,
} from '../src/modules/facile/renewals/appActions.js'
import {
  parseEmailGenerationConfiguration,
} from '../src/modules/facile/renewals/emailGenerationConfig.js'

function makeService({
  id,
  name,
  domain = name,
  customerId,
  customerName,
  groupId = null,
  groupName = null,
} = {}) {
  return {
    id,
    name,
    domains_id: domain ? {id: `domain-${id}`, name: domain} : null,
    customer: {
      id: customerId,
      name: customerName,
      group: groupId ? {id: groupId, name: groupName} : null,
    },
    subscriptions: [],
  }
}

const SERVICES = [
  makeService({
    id: 'service-eco-pv-hosting',
    name: 'eco-pv.it',
    customerId: 'customer-eco-pv',
    customerName: 'Consorzio Eco-Pv',
    groupId: 'group-zilio',
    groupName: 'Zilio Group Srl',
  }),
  makeService({
    id: 'service-eco-pv-assistance',
    name: 'Assistenza eco-pv.it',
    domain: null,
    customerId: 'customer-eco-pv',
    customerName: 'Consorzio Eco-Pv',
    groupId: 'group-zilio',
    groupName: 'Zilio Group Srl',
  }),
  makeService({
    id: 'service-zilio-customer',
    name: 'groupzilio.com',
    customerId: 'customer-zilio',
    customerName: 'Zilio Group Srl',
    groupId: 'group-zilio',
    groupName: 'Zilio Group Srl',
  }),
  makeService({
    id: 'service-standalone',
    name: 'standalone.it',
    customerId: 'customer-standalone',
    customerName: 'Cliente autonomo',
  }),
]

test('riconosce l’apertura della generazione email per un gruppo', () => {
  const request = parseOpenEmailGenerationAction(
    'apri la mail di rinnovo per il gruppo Zilio Group Srl'
  )

  assert.equal(request?.operation, 'open-email-generation')
  assert.equal(request?.purpose, 'renewal')
  assert.equal(request?.scopeHint, 'group')
  assert.equal(request?.namedTarget, 'Zilio Group Srl')
})

test('riconosce la preparazione della schermata email per un cliente', () => {
  const request = parseOpenEmailGenerationAction(
    'preparami la mail per il cliente Consorzio Eco-Pv'
  )

  assert.equal(request?.scopeHint, 'customer')
  assert.equal(request?.namedTarget, 'Consorzio Eco-Pv')
})

test('non intercetta bozze testuali o letture dello storico', () => {
  assert.equal(
    parseOpenEmailGenerationAction('scrivi una bozza email per eco-pv.it'),
    null
  )
  assert.equal(
    parseOpenEmailGenerationAction('qual è l’ultima email inviata per eco-pv.it?'),
    null
  )
})

test('risolve un gruppo tramite ID e nome di dominio', () => {
  const request = parseOpenEmailGenerationAction(
    'apri la mail per il gruppo Zilio Group Srl'
  )
  const resolution = resolveOpenEmailGenerationTarget({request, services: SERVICES})

  assert.equal(resolution.status, 'resolved')
  assert.deepEqual(resolution.scope, {
    type: 'group',
    id: 'group-zilio',
    label: 'Zilio Group Srl',
  })
})

test('risolve un cliente anche quando appartiene a un gruppo', () => {
  const request = parseOpenEmailGenerationAction(
    'genera la mail per il cliente Consorzio Eco-Pv'
  )
  const resolution = resolveOpenEmailGenerationTarget({request, services: SERVICES})

  assert.equal(resolution.status, 'resolved')
  assert.deepEqual(resolution.scope, {
    type: 'customer',
    id: 'customer-eco-pv',
    label: 'Consorzio Eco-Pv',
  })
})

test('un servizio apre la generazione email del relativo cliente', () => {
  const request = parseOpenEmailGenerationAction('portami alla mail per eco-pv.it')
  const resolution = resolveOpenEmailGenerationTarget({request, services: SERVICES})

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.source.kind, 'service')
  assert.deepEqual(resolution.scope, {
    type: 'customer',
    id: 'customer-eco-pv',
    label: 'Consorzio Eco-Pv',
  })
})

test('chiede chiarimento quando cliente e gruppo hanno lo stesso nome', () => {
  const request = parseOpenEmailGenerationAction('prepara la mail per Zilio Group Srl')
  const resolution = resolveOpenEmailGenerationTarget({request, services: SERVICES})

  assert.equal(resolution.status, 'ambiguous')
  assert.deepEqual(
    resolution.candidates.map(item => item.kind).sort(),
    ['customer', 'group']
  )
})

test('produce un contratto app-action esplicito e non esegue invii', () => {
  const result = buildOpenEmailGenerationAction({
    request: parseOpenEmailGenerationAction(
      'apri la mail per il cliente Consorzio Eco-Pv'
    ),
    services: SERVICES,
    actorToken: 'app-action-contract',
  })

  assert.equal(result.intent, 'app-action')
  assert.equal(result.data.type, 'app-action')
  assert.equal(result.data.appAction.id, OPEN_EMAIL_GENERATION_ACTION_ID)
  assert.equal(result.data.appAction.version, 2)
  assert.deepEqual(result.data.appAction.payload.scope, {
    type: 'customer',
    id: 'customer-eco-pv',
    label: 'Consorzio Eco-Pv',
  })
  assert.equal(result.data.appAction.payload.email.view, 'generation')
})

test('conserva e risolve un chiarimento tramite il tipo di entità', () => {
  const actorToken = 'app-action-clarification'
  const first = buildOpenEmailGenerationAction({
    request: parseOpenEmailGenerationAction('prepara la mail per Zilio Group Srl'),
    services: SERVICES,
    actorToken,
  })

  assert.equal(first.intent, 'clarification')
  assert.equal(hasPendingOpenEmailGenerationClarification({actorToken}), true)

  const second = handlePendingOpenEmailGenerationClarification({
    message: 'gruppo',
    actorToken,
  })

  assert.equal(second.intent, 'app-action')
  assert.equal(second.data.appAction.payload.scope.type, 'group')
  assert.equal(second.data.appAction.payload.scope.id, 'group-zilio')
  assert.equal(hasPendingOpenEmailGenerationClarification({actorToken}), false)
})

test('usa il contesto applicativo quando il comando non ripete il target', () => {
  const request = parseOpenEmailGenerationAction('apri la sezione email')
  const resolution = resolveOpenEmailGenerationTarget({
    request,
    services: SERVICES,
    scope: {customerId: 'customer-standalone'},
  })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.scope.type, 'customer')
  assert.equal(resolution.scope.id, 'customer-standalone')
})


test('un nuovo comando abbandona il chiarimento UI senza bloccare il routing successivo', () => {
  const actorToken = 'app-action-new-command'
  buildOpenEmailGenerationAction({
    request: parseOpenEmailGenerationAction('prepara la mail per Zilio Group Srl'),
    services: SERVICES,
    actorToken,
  })

  const result = handlePendingOpenEmailGenerationClarification({
    message: 'dettagli del piano DomProf10',
    actorToken,
  })

  assert.equal(result, null)
  assert.equal(hasPendingOpenEmailGenerationClarification({actorToken}), false)
})


test('interpreta una richiesta composita senza confondere l’oggetto con il cliente', () => {
  const request = parseOpenEmailGenerationAction(
    'preparami la mail per il cliente Consorzio Eco-Pv considerando scadenze entro 60 giorni, usando come oggetto "oggetto test" e mostrando i dati di occupazione per i servizi con piano domreg',
    {now: new Date('2026-08-05T12:00:00Z')}
  )

  assert.equal(request?.scopeHint, 'customer')
  assert.equal(request?.namedTarget, 'Consorzio Eco-Pv')
  assert.deepEqual(request?.configuration, {
    includeDomainRegistrationUsage: true,
    subject: 'oggetto test',
    analysisPeriodDays: 60,
  })
  assert.deepEqual(request?.configurationErrors, [])
})

test('converte una data limite futura nel numero di giorni del pannello', () => {
  const parsed = parseEmailGenerationConfiguration(
    'considera scadenze entro il 15 agosto 2026',
    {now: new Date('2026-08-05T12:00:00Z')}
  )

  assert.equal(parsed.configuration.analysisEndDate, '2026-08-15')
  assert.equal(parsed.configuration.analysisPeriodDays, 10)
})

test('riconosce una configurazione singola anche senza ripetere la parola email', () => {
  const request = parseOpenEmailGenerationAction(
    'mostra i dati di occupazione per i servizi con piano domreg'
  )

  assert.equal(request?.operation, 'open-email-generation')
  assert.equal(request?.namedTarget, null)
  assert.equal(request?.configuration.includeDomainRegistrationUsage, true)
})

test('una configurazione senza target mantiene la selezione corrente dell’app', () => {
  const request = parseOpenEmailGenerationAction(
    'considera scadenze entro 30 giorni e imposta oggetto email a: Rinnovi del mese'
  )
  const result = buildOpenEmailGenerationAction({
    request,
    services: SERVICES,
    actorToken: 'settings-only-action',
  })

  assert.equal(result.intent, 'app-action')
  assert.equal(result.data.appAction.payload.scope, null)
  assert.equal(result.data.appAction.payload.email.configuration.analysisPeriodDays, 30)
  assert.equal(result.data.appAction.payload.email.configuration.subject, 'Rinnovi del mese')
})

test('il contratto composito trasporta solo le impostazioni richieste', () => {
  const result = buildOpenEmailGenerationAction({
    request: parseOpenEmailGenerationAction(
      'preparami la mail per il cliente Consorzio Eco-Pv entro 45 giorni, mostra i rinnovi automatici e nascondi i dettagli dello sconto'
    ),
    services: SERVICES,
    actorToken: 'composite-contract',
  })

  assert.equal(result.intent, 'app-action')
  assert.deepEqual(result.data.appAction.payload.email.configuration, {
    showAutoRenewServices: true,
    hideDiscountDetails: true,
    analysisPeriodDays: 45,
  })
})

test('l’indirizzo di test attiva automaticamente la modalità test', () => {
  const request = parseOpenEmailGenerationAction(
    'apri la mail per il cliente Consorzio Eco-Pv con indirizzo email di test test@example.com'
  )

  assert.equal(request.configuration.testEmail, 'test@example.com')
  assert.equal(request.configuration.testMode, true)
})

test('rifiuta periodi fuori dal limite consentito', () => {
  const request = parseOpenEmailGenerationAction(
    'apri la mail considerando scadenze entro 900 giorni'
  )
  const result = buildOpenEmailGenerationAction({
    request,
    services: SERVICES,
    actorToken: 'invalid-period',
  })

  assert.equal(result.intent, 'clarification')
  assert.equal(result.data.reason, 'open-email-generation-invalid-configuration')
})

test('interpreta singolarmente tutti i flag configurabili della schermata Email', () => {
  const cases = [
    ['mostra tutti i servizi, anche non critici', 'showAllServices', true],
    ['mostra solo i servizi critici', 'showAllServices', false],
    ['mostra i dati di occupazione per i servizi con piano domreg', 'includeDomainRegistrationUsage', true],
    ['nascondi i dati di occupazione per i servizi con piano domreg', 'includeDomainRegistrationUsage', false],
    ['mostra gli add-on di Plesk', 'showPleskAddons', true],
    ['nascondi gli add-on di Plesk', 'showPleskAddons', false],
    ['mostra i servizi con rinnovo automatico', 'showAutoRenewServices', true],
    ['escludi i rinnovi automatici', 'showAutoRenewServices', false],
    ['nascondi i dettagli dello spazio utilizzato', 'hideUsageDetails', true],
    ['mostra i dettagli dello spazio utilizzato', 'hideUsageDetails', false],
    ['nascondi i dettagli dello sconto', 'hideDiscountDetails', true],
    ['mostra i dettagli dello sconto', 'hideDiscountDetails', false],
    ['limita i servizi con spazio esaurito entro il periodo', 'limitFullSpaceToPeriod', true],
    ['non limitare i servizi con spazio esaurito al periodo', 'limitFullSpaceToPeriod', false],
    ['mostra i servizi in esaurimento oltre il periodo', 'includeFutureLowSpace', true],
    ['nascondi i servizi in esaurimento oltre il periodo', 'includeFutureLowSpace', false],
    ['mostra anche i servizi già contattati negli ultimi 6 mesi', 'showRecentlyContacted', true],
    ['nascondi i servizi già contattati', 'showRecentlyContacted', false],
    ['nascondi i servizi di upgrade già comunicati', 'hideRecentlyCommunicatedUpgrades', true],
    ['mostra i servizi di upgrade già comunicati', 'hideRecentlyCommunicatedUpgrades', false],
    ['attiva la modalità test', 'testMode', true],
    ['disattiva la modalità test', 'testMode', false],
  ]

  for (const [message, field, expected] of cases) {
    const request = parseOpenEmailGenerationAction(message)
    assert.equal(request?.operation, 'open-email-generation', message)
    assert.equal(request?.configuration?.[field], expected, message)
  }
})

test('interpreta destinatario, email di test e oggetto come campi indipendenti', () => {
  const request = parseOpenEmailGenerationAction(
    'imposta come destinatario amministrazione@example.com, attiva la modalità test con indirizzo email di test test@example.com e usa come oggetto "Rinnovi agosto"'
  )

  assert.equal(request.configuration.recipientEmail, 'amministrazione@example.com')
  assert.equal(request.configuration.testEmail, 'test@example.com')
  assert.equal(request.configuration.testMode, true)
  assert.equal(request.configuration.subject, 'Rinnovi agosto')
})

test('in una richiesta composta prevale l’ultima istruzione sullo stesso flag', () => {
  const request = parseOpenEmailGenerationAction(
    'mostra i dettagli dello sconto e poi nascondi i dettagli dello sconto'
  )

  assert.equal(request.configuration.hideDiscountDetails, true)
})
