import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {
  buildRecentCompletedSupplierRenewalUndoReply,
  buildSupplierRenewalExecutionProposalFromPreview,
  handlePendingSupplierRenewalExecutionDecisionMessage,
  handlePendingSupplierRenewalExecutionClarification,
  handleSupplierRenewalExecutionDecision,
  handleSupplierRenewalExecutionRequest,
  isRecentCompletedSupplierRenewalUndoRequest,
  parseSupplierRenewalExecutionRequest,
} from '../src/modules/facile/renewals/supplierRenewalExecution.js'
import {
  buildSupplierRenewalPreviewPayload,
  parseSupplierRenewalPreviewRequest,
} from '../src/modules/facile/renewals/supplierRenewalPreview.js'

function makeSupplierSubscription(overrides = {}) {
  return {
    id: 'supplier-subscription-register',
    isSupplier: true,
    startsOn: '2026-02-15T12:00:00',
    endsOn: '2027-02-15T12:00:00',
    plan: {
      id: 'supplier-plan-register',
      name: 'MisterDomainDom-it',
      duration: 12,
      priceFinal: 18,
      missingPrice: false,
      supplier: {id: 'supplier-register', name: 'MisterDomain'},
    },
    addons: [],
    ...overrides,
  }
}

function makeService(overrides = {}) {
  const supplierSubscription = makeSupplierSubscription()
  const service = {
    id: 'service-webcloud-it',
    name: 'webcloud.it',
    domains_id: {id: 'domain-webcloud-it', name: 'webcloud.it'},
    customer: {
      id: 'customer-webcloud',
      name: 'WebCloud',
      group: {id: 'group-webcloud', name: 'WebCloud'},
    },
    dontRenew: false,
    toTransfer: null,
    authCode: null,
    subscriptions: [
      {
        id: 'customer-subscription',
        isSupplier: false,
        startsOn: '2027-02-13T12:00:00',
        endsOn: '2028-02-13T12:00:00',
        plan: {
          id: 'customer-plan',
          name: 'DomProf170 NoSSL',
          duration: 12,
          supplier: {id: 'supplier-webcloud', name: 'Webcloud'},
        },
        addons: [],
        suppliersSubscriptions: [supplierSubscription],
      },
    ],
  }

  return {...service, ...overrides}
}

function makeCandidate(service = makeService(), index = 0) {
  const customerSubscription = service.subscriptions[0]
  return {
    subscription: customerSubscription.suppliersSubscriptions[index],
    customerSubscription,
  }
}

function makeReadyPreview(service = makeService(), mode = 'renew-by-plan-duration') {
  const candidate = makeCandidate(service)
  return buildSupplierRenewalPreviewPayload({
    service,
    supplierSubscription: candidate.subscription,
    customerSubscription: candidate.customerSubscription,
    mode,
  })
}

describe('Parser rinnovo fornitore reale', () => {
  test('riconosce il comando diretto', () => {
    const request = parseSupplierRenewalExecutionRequest(
      'rinnova la sottoscrizione fornitore di webcloud.it'
    )

    assert.equal(request?.type, 'renewals-supplier-renewal-execution-request')
    assert.equal(request?.mode, 'renew-by-plan-duration')
    assert.equal(request?.namedTarget, 'webcloud.it')
  })

  test('riconosce l’allineamento reale alla scadenza cliente', () => {
    const request = parseSupplierRenewalExecutionRequest(
      'allinea la scadenza fornitore alla nuova scadenza cliente di webcloud.it'
    )

    assert.equal(request?.mode, 'align-customer-expiry')
    assert.equal(request?.namedTarget, 'webcloud.it')
  })

  test('riconosce il riferimento alla lista', () => {
    const request = parseSupplierRenewalExecutionRequest(
      'rinnova la sottoscrizione fornitore del secondo'
    )

    assert.equal(request?.selector?.kind, 'position')
    assert.equal(request?.selector?.position, 2)
  })

  test('non intercetta una richiesta di anteprima', () => {
    assert.equal(
      parseSupplierRenewalExecutionRequest(
        'prepara il rinnovo della sottoscrizione fornitore di webcloud.it'
      ),
      null
    )
    assert.ok(
      parseSupplierRenewalPreviewRequest(
        'prepara il rinnovo della sottoscrizione fornitore di webcloud.it'
      )
    )
  })
})

describe('Proposta rinnovo fornitore reale', () => {
  test('genera una proposta non reversibile', () => {
    const service = makeService()
    const result = buildSupplierRenewalExecutionProposalFromPreview({
      service,
      candidate: makeCandidate(service),
      preview: makeReadyPreview(service),
      actorToken: 'supplier-execution-proposal',
    })

    assert.equal(result.intent, 'action-proposal')
    assert.equal(result.data.action.requiresConfirmation, true)
    assert.equal(result.data.action.reversible, false)
    assert.equal(result.data.action.subscription.type, 'supplier')
    assert.match(result.reply, /Non verrà eseguito alcun ordine/i)
  })

  test('blocca la proposta con NON RINNOVARE', () => {
    const service = makeService({dontRenew: true})
    const result = buildSupplierRenewalExecutionProposalFromPreview({
      service,
      candidate: makeCandidate(service),
      preview: makeReadyPreview(service),
      actorToken: 'supplier-execution-blocked',
    })

    assert.equal(result.ok, true)
    assert.equal(result.intent, 'action-error')
    assert.equal(result.data.error.code, 'supplier-renewal-preview-blocked')
    assert.match(result.reply, /non può essere eseguito/i)
  })
})

describe('Conferma rinnovo fornitore reale', () => {
  test('conferma ed esegue con stale-state completo', async () => {
    const service = makeService()
    const candidate = makeCandidate(service)
    const actorToken = 'supplier-execution-confirm'
    const proposal = buildSupplierRenewalExecutionProposalFromPreview({
      service,
      candidate,
      preview: makeReadyPreview(service),
      actorToken,
    })

    let received = null
    const result = await handleSupplierRenewalExecutionDecision({
      action: {actionId: proposal.data.action.actionId, decision: 'confirm'},
      actorToken,
      executeFn: async payload => {
        received = payload
        return {
          status: 'completed',
          changed: true,
          service: {id: service.id},
          subscription: {
            id: candidate.subscription.id,
            previousEndDate: candidate.subscription.endsOn,
            endsOn: '2028-02-15T12:00:00',
          },
          warnings: [],
        }
      },
    })

    assert.equal(result.intent, 'action-result')
    assert.equal(received.serviceId, service.id)
    assert.equal(received.subscriptionId, candidate.subscription.id)
    assert.equal(received.expectedEndDate, '2027-02-15T12:00:00')
    assert.equal(received.newEndDate, '2028-02-15T12:00:00')
    assert.equal(received.expectedCustomerSubscriptionId, 'customer-subscription')
    assert.equal(result.data.result.externalSupplierUpdated, false)
    assert.equal(result.data.result.pleskUpdated, false)
  })

  test('annulla senza eseguire', async () => {
    const service = makeService()
    const actorToken = 'supplier-execution-cancel'
    const proposal = buildSupplierRenewalExecutionProposalFromPreview({
      service,
      candidate: makeCandidate(service),
      preview: makeReadyPreview(service),
      actorToken,
    })

    let executed = false
    const result = await handleSupplierRenewalExecutionDecision({
      action: {actionId: proposal.data.action.actionId, decision: 'cancel'},
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
    const candidate = makeCandidate(service)
    const actorToken = 'supplier-execution-text-confirm'

    buildSupplierRenewalExecutionProposalFromPreview({
      service,
      candidate,
      preview: makeReadyPreview(service),
      actorToken,
    })

    const result = await handlePendingSupplierRenewalExecutionDecisionMessage({
      message: 'confermo',
      actorToken,
      executeFn: async () => ({
        status: 'completed',
        changed: true,
        service: {id: service.id},
        subscription: {
          id: candidate.subscription.id,
          previousEndDate: candidate.subscription.endsOn,
          endsOn: '2028-02-15T12:00:00',
        },
        warnings: [],
      }),
    })

    assert.equal(result.intent, 'action-result')
  })

  test('non propone undo automatico dopo il rinnovo', async () => {
    const service = makeService()
    const candidate = makeCandidate(service)
    const actorToken = 'supplier-execution-no-undo'
    const proposal = buildSupplierRenewalExecutionProposalFromPreview({
      service,
      candidate,
      preview: makeReadyPreview(service),
      actorToken,
    })

    await handleSupplierRenewalExecutionDecision({
      action: {actionId: proposal.data.action.actionId, decision: 'confirm'},
      actorToken,
      executeFn: async () => ({
        status: 'completed',
        changed: true,
        service: {id: service.id},
        subscription: {
          id: candidate.subscription.id,
          previousEndDate: candidate.subscription.endsOn,
          endsOn: '2028-02-15T12:00:00',
        },
        warnings: [],
      }),
    })

    assert.equal(isRecentCompletedSupplierRenewalUndoRequest('annulla', {actorToken}), true)
    const reply = buildRecentCompletedSupplierRenewalUndoReply({actorToken})
    assert.equal(reply.data.result.status, 'not-reversible')
  })
})

describe('Risoluzione rinnovo fornitore reale', () => {
  test('preferisce il dominio esatto e costruisce la proposta', async () => {
    const service = makeService()
    const result = await handleSupplierRenewalExecutionRequest({
      request: parseSupplierRenewalExecutionRequest(
        'rinnova la sottoscrizione fornitore di webcloud.it'
      ),
      services: [
        service,
        makeService({id: 'same-name-no-domain', domains_id: null}),
      ],
      settings: {},
      history: [],
      scope: {},
      actorToken: 'supplier-execution-exact-domain',
    })

    assert.equal(result.intent, 'action-proposal')
    assert.equal(result.data.preview.service.id, service.id)
  })

  test('chiede quale sottoscrizione usare e accetta la risposta numerica', async () => {
    const service = makeService()
    service.subscriptions[0].suppliersSubscriptions.push(
      makeSupplierSubscription({
        id: 'supplier-subscription-second',
        endsOn: '2027-03-01T12:00:00',
        plan: {
          id: 'supplier-plan-second',
          name: 'Secondo piano',
          duration: 12,
          supplier: {id: 'supplier-second', name: 'Secondo fornitore'},
        },
      })
    )

    const actorToken = 'supplier-execution-clarification'
    const first = await handleSupplierRenewalExecutionRequest({
      request: parseSupplierRenewalExecutionRequest(
        'rinnova la sottoscrizione fornitore di webcloud.it'
      ),
      services: [service],
      settings: {},
      history: [],
      scope: {},
      actorToken,
    })

    assert.equal(first.intent, 'clarification')

    const second = await handlePendingSupplierRenewalExecutionClarification({
      message: '2',
      services: [service],
      actorToken,
    })

    assert.equal(second.intent, 'action-proposal')
    assert.equal(second.data.action.subscription.id, 'supplier-subscription-second')
  })

  test('accetta "prima" nella selezione del servizio ambiguo', async () => {
    const firstService = makeService()
    const secondService = makeService({
      id: 'service-fede-webcloud-it',
      name: 'fede.webcloud.it',
      domains_id: {id: 'domain-shared-webcloud-it', name: 'webcloud.it'},
    })
    const actorToken = 'supplier-execution-service-ordinal'

    const first = await handleSupplierRenewalExecutionRequest({
      request: parseSupplierRenewalExecutionRequest(
        'rinnova la sottoscrizione fornitore di webcloud.it'
      ),
      services: [firstService, secondService],
      settings: {},
      history: [],
      scope: {},
      actorToken,
    })

    assert.equal(first.intent, 'clarification')

    const second = await handlePendingSupplierRenewalExecutionClarification({
      message: 'prima',
      services: [firstService, secondService],
      actorToken,
    })

    assert.equal(second.ok, true)
    assert.equal(second.intent, 'action-proposal')
    assert.equal(second.data.preview.service.id, firstService.id)
  })
})
