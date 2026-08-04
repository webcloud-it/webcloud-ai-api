import assert from 'node:assert/strict'
import {afterEach, beforeEach, describe, test} from 'node:test'

import {
  buildCopySupplierExpiryToCustomerActionPreview,
  buildServiceAuthCodeActionPreview,
  buildServiceFlagActionPreview,
  buildServiceInvoiceDateActionPreview,
  buildServicePleskPlanSyncActionPreview,
  buildServiceSubscriptionEndDateActionPreview,
  buildServiceTransferTargetActionPreview,
  handlePendingRenewalsActionDecisionMessage,
  isRecentRenewalsActionUndoRequest,
  parseCopySupplierExpiryToCustomerAction,
  parseServiceAuthCodeAction,
  parseServiceFlagAction,
  parseServiceInvoiceDateAction,
  parseServicePleskPlanSyncAction,
  parseServiceSubscriptionEndDateAction,
  parseServiceTransferTargetAction,
} from '../src/modules/facile/renewals/actions.js'

const originalConsoleInfo = console.info

beforeEach(() => {
  console.info = () => {}
})

afterEach(() => {
  console.info = originalConsoleInfo
})

function makeService(overrides = {}) {
  return {
    id: 'service-eco-pv',
    name: 'eco-pv.it',
    domains_id: {id: 'domain-eco-pv', name: 'eco-pv.it'},
    customer: {
      id: 'customer-eco-pv',
      name: 'Consorzio Eco-Pv',
      group: {id: 'group-zilio', name: 'Zilio Group Srl'},
    },
    toRenew: false,
    dontRenew: false,
    autoRenew: false,
    toTransfer: null,
    invoiceDate: null,
    pleskPlansSync: true,
    authCode: null,
    pleskDomain: {id: 'plesk-domain-eco-pv'},
    subscriptions: [
      {
        id: 'customer-subscription',
        isSupplier: false,
        startsOn: '2026-03-03T12:00:00',
        endsOn: '2027-03-03T12:00:00',
        plan: {
          id: 'customer-plan',
          name: 'DomProf170 NoSSL',
          supplier: {id: 'supplier-webcloud', name: 'Webcloud'},
        },
        addons: [],
        suppliersSubscriptions: [
          {
            id: 'supplier-subscription',
            isSupplier: true,
            startsOn: '2026-03-03T12:00:00',
            endsOn: '2027-04-03T12:00:00',
            plan: {
              id: 'supplier-plan',
              name: 'DomReg',
              supplier: {id: 'supplier-register', name: 'Register'},
            },
            addons: [],
          },
        ],
      },
    ],
    ...overrides,
  }
}

function previewArgs(request, overrides = {}) {
  return {
    request,
    services: [makeService(overrides.service)],
    providers: [
      {label: 'Register', value: 'supplier-register'},
      {label: 'Webcloud', value: 'supplier-webcloud'},
    ],
    settings: {},
    history: [],
    scope: {},
    actorToken: overrides.actorToken || `test-${Math.random()}`,
  }
}

function getAction(result) {
  assert.equal(result?.intent, 'action-proposal')
  assert.equal(result?.data?.type, 'action-preview')
  assert.equal(result?.data?.action?.requiresConfirmation, true)

  return result.data.action
}

describe('Parser delle action', () => {
  test('riconosce NON RINNOVARE', () => {
    const request = parseServiceFlagAction('segna eco-pv.it come da non rinnovare')

    assert.equal(request?.field, 'dontRenew')
    assert.equal(request?.desiredValue, true)
    assert.equal(request?.namedTarget, 'eco-pv.it')
  })

  test('riconosce il trasferimento verso un fornitore', () => {
    const request = parseServiceTransferTargetAction(
      'segna eco-pv.it da trasferire a Register'
    )

    assert.equal(request?.providerQuery, 'Register')
    assert.equal(request?.namedTarget, 'eco-pv.it')
  })

  test('riconosce la data di fatturazione senza includerla nel servizio', () => {
    const request = parseServiceInvoiceDateAction(
      'imposta la data di fatturazione di eco-pv.it al 15 settembre 2026'
    )

    assert.equal(request?.namedTarget, 'eco-pv.it')
    assert.match(request?.desiredDate || '', /^2026-09-15T12:00:00/)
  })

  test('riconosce la scadenza della sottoscrizione cliente', () => {
    const request = parseServiceSubscriptionEndDateAction(
      'imposta la scadenza cliente di eco-pv.it al 3 marzo 2028'
    )

    assert.equal(request?.subscriptionType, 'customer')
    assert.equal(request?.namedTarget, 'eco-pv.it')
    assert.match(request?.desiredDate || '', /^2028-03-03T12:00:00/)
  })

  test('riconosce la copia della scadenza fornitore', () => {
    const request = parseCopySupplierExpiryToCustomerAction(
      'copia la scadenza del fornitore sulla scadenza cliente di eco-pv.it'
    )

    assert.equal(request?.namedTarget, 'eco-pv.it')
  })

  test('riconosce la disattivazione della sincronizzazione Plesk', () => {
    const request = parseServicePleskPlanSyncAction(
      'disattiva la sincronizzazione del piano Plesk per eco-pv.it'
    )

    assert.equal(request?.desiredValue, false)
    assert.equal(request?.namedTarget, 'eco-pv.it')
  })

  test('riconosce e oscura l’auth code', () => {
    const request = parseServiceAuthCodeAction("imposta l'auth code di eco-pv.it a ABC123")

    assert.equal(request?.desiredAuthCode, 'ABC123')
    assert.equal(request?.namedTarget, 'eco-pv.it')
    assert.doesNotMatch(request?.message || '', /ABC123/)
    assert.match(request?.message || '', /RISERVATO/)
  })

  test('una domanda sulla scadenza non viene interpretata come action', () => {
    assert.equal(parseServiceSubscriptionEndDateAction('quando scade eco-pv.it?'), null)
  })

  test('una lista per anno non viene interpretata come action', () => {
    assert.equal(
      parseServiceSubscriptionEndDateAction('tutti i servizi che scadono nel 2027'),
      null
    )
  })

  test('riconosce le richieste di undo', () => {
    for (const message of [
      'annulla l’ultima operazione',
      'torna indietro',
      'rimetti com’era',
    ]) {
      assert.equal(isRecentRenewalsActionUndoRequest(message), true, message)
    }
  })
})

describe('Anteprime delle action', () => {
  test('applica le regole combinate di NON RINNOVARE', () => {
    const request = parseServiceFlagAction('segna eco-pv.it come da non rinnovare')
    const result = buildServiceFlagActionPreview(
      previewArgs(request, {
        service: {
          autoRenew: true,
          toRenew: true,
        },
      })
    )
    const action = getAction(result)
    const changes = new Map(action.changes.map(change => [change.field, change]))

    assert.equal(changes.get('dontRenew')?.to, true)
    assert.equal(changes.get('autoRenew')?.to, false)
    assert.equal(changes.get('toRenew')?.to, false)
  })

  test('la proposta di trasferimento non avvia il trasferimento', () => {
    const request = parseServiceTransferTargetAction(
      'segna eco-pv.it da trasferire a Register'
    )
    const action = getAction(buildServiceTransferTargetActionPreview(previewArgs(request)))

    assert.equal(action.changes[0].to.name, 'Register')
    assert.equal(action.effects.startsTransfer, false)
    assert.equal(action.effects.changesCurrentSupplier, false)
  })

  test('la proposta di fatturazione mantiene servizio e data separati', () => {
    const request = parseServiceInvoiceDateAction(
      'imposta la data di fatturazione di eco-pv.it al 15 settembre 2026'
    )
    const action = getAction(buildServiceInvoiceDateActionPreview(previewArgs(request)))

    assert.equal(action.target.label, 'eco-pv.it')
    assert.match(action.changes[0].to, /^2026-09-15T12:00:00/)
  })

  test('la proposta di scadenza seleziona la sottoscrizione cliente', () => {
    const request = parseServiceSubscriptionEndDateAction(
      'imposta la scadenza cliente di eco-pv.it al 3 marzo 2028'
    )
    const action = getAction(buildServiceSubscriptionEndDateActionPreview(previewArgs(request)))

    assert.equal(action.subscription.id, 'customer-subscription')
    assert.equal(action.subscription.type, 'customer')
    assert.match(action.changes[0].to, /^2028-03-03T12:00:00/)
  })

  test('la copia usa la sottoscrizione fornitore come sorgente', () => {
    const request = parseCopySupplierExpiryToCustomerAction(
      'copia la scadenza del fornitore sulla scadenza cliente di eco-pv.it'
    )
    const action = getAction(
      buildCopySupplierExpiryToCustomerActionPreview(previewArgs(request))
    )

    assert.equal(action.subscription.id, 'customer-subscription')
    assert.equal(action.sourceSubscription.id, 'supplier-subscription')
    assert.equal(action.changes[0].to, '2027-04-03T12:00:00')
  })

  test('la proposta Plesk non modifica il piano corrente', () => {
    const request = parseServicePleskPlanSyncAction(
      'disattiva la sincronizzazione del piano Plesk per eco-pv.it'
    )
    const action = getAction(buildServicePleskPlanSyncActionPreview(previewArgs(request)))

    assert.equal(action.changes[0].to, false)
    assert.equal(action.effects.changesCurrentPlan, false)
    assert.equal(action.effects.affectsFuturePlanChanges, true)
  })

  test('l’anteprima auth code non espone il valore', () => {
    const request = parseServiceAuthCodeAction("imposta l'auth code di eco-pv.it a ABC123")
    const result = buildServiceAuthCodeActionPreview(previewArgs(request))
    const action = getAction(result)
    const serialized = JSON.stringify(result)

    assert.doesNotMatch(serialized, /ABC123/)
    assert.equal(action.effects.sensitiveValue, true)
    assert.equal(action.effects.valueExposedInResponse, false)
    assert.equal(action.effects.valueIncludedInActionAudit, false)
  })

  test('una proposta può essere annullata senza eseguire modifiche', async () => {
    const actorToken = 'cancel-test-token'
    const request = parseServiceInvoiceDateAction(
      'imposta la data di fatturazione di eco-pv.it al 15 settembre 2026'
    )

    buildServiceInvoiceDateActionPreview(previewArgs(request, {actorToken}))

    const result = await handlePendingRenewalsActionDecisionMessage({
      message: 'annulla',
      actorToken,
    })

    assert.equal(result?.intent, 'action-confirmation')
    assert.equal(result?.data?.decision, 'cancel')
    assert.equal(result?.data?.status, 'cancelled')
    assert.match(result?.reply || '', /Nessuna modifica è stata eseguita/i)
  })
})
