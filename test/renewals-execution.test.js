import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {
  buildRecentCompletedRenewalUndoReply,
  buildRenewalExecutionProposalFromPreview,
  handlePendingRenewalExecutionDecisionMessage,
  handleRenewalExecutionDecision,
  handleRenewalExecutionRequest,
  isRecentCompletedRenewalUndoRequest,
  parseRenewalExecutionRequest,
} from '../src/modules/facile/renewals/renewalExecution.js'
import {buildRenewalPreviewPayload} from '../src/modules/facile/renewals/renewalPreview.js'

function makeService(overrides = {}) {
  const service = {
    id: 'service-eco-pv',
    name: 'eco-pv.it',
    domains_id: {id: 'domain-eco-pv', name: 'eco-pv.it'},
    customer: {
      id: 'customer-eco-pv',
      name: 'Consorzio Eco-Pv',
      group: {id: 'group-zilio', name: 'Zilio Group Srl'},
    },
    dontRenew: false,
    autoRenew: false,
    toRenew: true,
    toTransfer: null,
    pleskPlansSync: true,
    pleskDomain: {
      id: 'plesk-domain-eco-pv',
      integration_id: 'plesk-guid-eco-pv',
    },
    subscriptions: [
      {
        id: 'customer-subscription',
        isSupplier: false,
        startsOn: '2026-03-03T12:00:00',
        endsOn: '2027-03-03T12:00:00',
        plan: {
          id: 'customer-plan',
          name: 'DomProf170 NoSSL',
          duration: 12,
          priceFinal: 240,
          missingPrice: false,
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
              duration: 12,
              supplier: {id: 'supplier-register', name: 'Register'},
            },
          },
        ],
      },
    ],
  }

  return {...service, ...overrides}
}

function makeReadyPreview(service = makeService()) {
  return buildRenewalPreviewPayload({
    service,
    customerSubscription: service.subscriptions[0],
    httpCheck: {
      checked: true,
      ok: true,
      status: 200,
      protocolTried: 'https',
      finalUrl: 'https://eco-pv.it/',
    },
    pleskAudit: {ok: true, items: []},
  })
}

describe('Parser rinnovo reale', () => {
  test('riconosce il comando diretto', () => {
    const request = parseRenewalExecutionRequest('rinnova eco-pv.it')

    assert.equal(request?.type, 'renewals-renewal-execution-request')
    assert.equal(request?.namedTarget, 'eco-pv.it')
  })

  test('riconosce il riferimento alla lista', () => {
    const request = parseRenewalExecutionRequest('rinnova il secondo')

    assert.equal(request?.selector?.kind, 'position')
    assert.equal(request?.selector?.position, 2)
  })

  test('non intercetta una richiesta di anteprima', () => {
    assert.equal(parseRenewalExecutionRequest('prepara il rinnovo di eco-pv.it'), null)
  })

  test('non intercetta una lista', () => {
    assert.equal(parseRenewalExecutionRequest('tutti i servizi da rinnovare'), null)
  })
})

describe('Proposta rinnovo reale', () => {
  test('genera una action-proposal non reversibile', () => {
    const service = makeService()
    const result = buildRenewalExecutionProposalFromPreview({
      service,
      customerSubscription: service.subscriptions[0],
      preview: makeReadyPreview(service),
      actorToken: 'proposal-ready',
    })

    assert.equal(result.intent, 'action-proposal')
    assert.equal(result.data.action.requiresConfirmation, true)
    assert.equal(result.data.action.reversible, false)
    assert.equal(result.data.action.subscription.id, 'customer-subscription')
  })

  test('blocca la proposta con NON RINNOVARE', () => {
    const service = makeService({dontRenew: true})
    const result = buildRenewalExecutionProposalFromPreview({
      service,
      customerSubscription: service.subscriptions[0],
      preview: makeReadyPreview(service),
      actorToken: 'proposal-blocked',
    })

    assert.equal(result.ok, true)
    assert.equal(result.intent, 'action-error')
    assert.equal(result.data.error.code, 'renewal-preview-blocked')
    assert.match(result.reply, /non può essere eseguito/i)
  })
})

describe('Conferma rinnovo reale', () => {
  test('conferma ed esegue con i valori attesi', async () => {
    const service = makeService()
    const actorToken = 'execution-confirm'
    const proposal = buildRenewalExecutionProposalFromPreview({
      service,
      customerSubscription: service.subscriptions[0],
      preview: makeReadyPreview(service),
      actorToken,
    })

    let received = null
    const result = await handleRenewalExecutionDecision({
      action: {
        actionId: proposal.data.action.actionId,
        decision: 'confirm',
      },
      actorToken,
      executeFn: async payload => {
        received = payload
        return {
          status: 'completed',
          changed: true,
          service: {id: service.id, flags: {toRenew: false}},
          subscription: {
            id: service.subscriptions[0].id,
            previousEndDate: service.subscriptions[0].endsOn,
            endsOn: '2028-03-03T12:00:00',
          },
          plesk: {required: true, updated: true},
          warnings: [],
        }
      },
    })

    assert.equal(result.intent, 'action-result')
    assert.equal(received.serviceId, service.id)
    assert.equal(received.subscriptionId, service.subscriptions[0].id)
    assert.equal(received.expectedEndDate, '2027-03-03T12:00:00')
    assert.equal(received.newEndDate, '2028-03-03T12:00:00')
  })

  test('annulla senza eseguire', async () => {
    const service = makeService()
    const actorToken = 'execution-cancel'
    const proposal = buildRenewalExecutionProposalFromPreview({
      service,
      customerSubscription: service.subscriptions[0],
      preview: makeReadyPreview(service),
      actorToken,
    })

    let executed = false
    const result = await handleRenewalExecutionDecision({
      action: {
        actionId: proposal.data.action.actionId,
        decision: 'cancel',
      },
      actorToken,
      executeFn: async () => {
        executed = true
      },
    })

    assert.equal(result.data.status, 'cancelled')
    assert.equal(executed, false)
  })

  test('riconosce confermo come decisione testuale', async () => {
    const service = makeService()
    const actorToken = 'execution-text-confirm'

    buildRenewalExecutionProposalFromPreview({
      service,
      customerSubscription: service.subscriptions[0],
      preview: makeReadyPreview(service),
      actorToken,
    })

    const result = await handlePendingRenewalExecutionDecisionMessage({
      message: 'confermo',
      actorToken,
      executeFn: async () => ({
        status: 'completed',
        changed: true,
        service: {id: service.id, flags: {toRenew: false}},
        subscription: {
          id: service.subscriptions[0].id,
          previousEndDate: service.subscriptions[0].endsOn,
          endsOn: '2028-03-03T12:00:00',
        },
        plesk: {required: false, updated: false},
        warnings: [],
      }),
    })

    assert.equal(result.intent, 'action-result')
  })

  test('non propone undo automatico dopo il rinnovo', async () => {
    const service = makeService()
    const actorToken = 'execution-no-undo'
    const proposal = buildRenewalExecutionProposalFromPreview({
      service,
      customerSubscription: service.subscriptions[0],
      preview: makeReadyPreview(service),
      actorToken,
    })

    await handleRenewalExecutionDecision({
      action: {actionId: proposal.data.action.actionId, decision: 'confirm'},
      actorToken,
      executeFn: async () => ({
        status: 'completed',
        changed: true,
        service: {id: service.id, flags: {toRenew: false}},
        subscription: {
          id: service.subscriptions[0].id,
          previousEndDate: service.subscriptions[0].endsOn,
          endsOn: '2028-03-03T12:00:00',
        },
        plesk: {required: true, updated: true},
        warnings: [],
      }),
    })

    assert.equal(isRecentCompletedRenewalUndoRequest('annulla', {actorToken}), true)
    const reply = buildRecentCompletedRenewalUndoReply({actorToken})
    assert.equal(reply.data.result.status, 'not-reversible')
  })
})

describe('Risoluzione rinnovo reale', () => {
  test('usa dominio esatto e costruisce la proposta', async () => {
    const service = makeService()
    const result = await handleRenewalExecutionRequest({
      request: parseRenewalExecutionRequest('rinnova eco-pv.it'),
      services: [
        service,
        makeService({id: 'same-name-no-domain', domains_id: null, pleskDomain: null}),
      ],
      settings: {},
      history: [],
      scope: {},
      actorToken: 'execution-exact-domain',
      checksLoader: async () => ({
        httpCheck: {checked: true, ok: true, status: 200},
        httpCheckError: null,
        pleskAudit: {ok: true, items: []},
        pleskAuditError: null,
      }),
    })

    assert.equal(result.intent, 'action-proposal')
    assert.equal(result.data.preview.service.id, service.id)
  })
})
