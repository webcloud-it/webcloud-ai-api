import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {
  buildFullRenewalPreviewPayload,
  parseFullRenewalPreviewRequest,
} from '../src/modules/facile/renewals/fullRenewalPreview.js'
import {
  buildFullRenewalExecutionProposalFromPreview,
  handleFullRenewalExecutionDecision,
  handleFullRenewalExecutionRequest,
  handlePendingFullRenewalExecutionClarification,
  parseFullRenewalExecutionRequest,
} from '../src/modules/facile/renewals/fullRenewalExecution.js'

function makeSupplierSubscription(overrides = {}) {
  return {
    id: 'supplier-subscription',
    isSupplier: true,
    startsOn: '2026-04-03T12:00:00',
    endsOn: '2027-04-03T12:00:00',
    plan: {
      id: 'supplier-plan',
      name: 'DomReg',
      duration: 12,
      priceFinal: 18,
      missingPrice: false,
      supplier: {id: 'supplier-register', name: 'Register'},
    },
    addons: [],
    ...overrides,
  }
}

function makeService(overrides = {}) {
  const supplierSubscription = makeSupplierSubscription()
  const customerSubscription = {
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
    suppliersSubscriptions: [supplierSubscription],
  }

  return {
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
    subscriptions: [customerSubscription],
    ...overrides,
  }
}

function getSelection(service = makeService()) {
  const customerSubscription = service.subscriptions[0]
  const supplierCandidate = {
    subscription: customerSubscription.suppliersSubscriptions[0],
    customerSubscription,
  }
  return {customerSubscription, supplierCandidate}
}

function makeReadyPreview(service = makeService()) {
  const {customerSubscription, supplierCandidate} = getSelection(service)

  return buildFullRenewalPreviewPayload({
    service,
    customerSubscription,
    supplierCandidate,
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

const checksLoader = async service => ({
  httpCheck: {
    checked: true,
    ok: true,
    status: 200,
    protocolTried: 'https',
    finalUrl: `https://${service?.domains_id?.name || service?.name}/`,
  },
  pleskAudit: {ok: true, items: []},
})

describe('Parser rinnovo completo', () => {
  test('riconosce l’esecuzione diretta', () => {
    const request = parseFullRenewalExecutionRequest('rinnova completamente eco-pv.it')

    assert.equal(request?.type, 'renewals-full-renewal-execution-request')
    assert.equal(request?.namedTarget, 'eco-pv.it')
  })

  test('riconosce cliente e fornitore', () => {
    const request = parseFullRenewalExecutionRequest(
      'rinnova cliente e fornitore di eco-pv.it'
    )

    assert.equal(request?.namedTarget, 'eco-pv.it')
  })

  test('separa l’anteprima dall’esecuzione', () => {
    assert.equal(
      parseFullRenewalExecutionRequest('prepara il rinnovo completo di eco-pv.it'),
      null
    )
    assert.ok(parseFullRenewalPreviewRequest('prepara il rinnovo completo di eco-pv.it'))
  })

  test('riconosce il riferimento alla lista', () => {
    const request = parseFullRenewalExecutionRequest('rinnova completamente il secondo')

    assert.equal(request?.selector?.kind, 'position')
    assert.equal(request?.selector?.position, 2)
  })
})

describe('Anteprima rinnovo completo', () => {
  test('combina cliente, fornitore e Plesk', () => {
    const preview = makeReadyPreview()

    assert.equal(preview.status, 'ready')
    assert.equal(
      preview.customerRenewal.customerSubscription.proposedEndDate,
      '2028-03-03T12:00:00'
    )
    assert.equal(
      preview.supplierRenewal.supplierSubscription.proposedEndDate,
      '2028-04-03T12:00:00'
    )
    assert.equal(preview.plesk.connected, true)
  })

  test('blocca il rinnovo completo senza sottoscrizione fornitore', () => {
    const service = makeService()
    service.subscriptions[0].suppliersSubscriptions = []

    const preview = buildFullRenewalPreviewPayload({
      service,
      customerSubscription: service.subscriptions[0],
      supplierCandidate: null,
      httpCheck: {checked: true, ok: true, status: 200},
      pleskAudit: {ok: true, items: []},
    })

    assert.equal(preview.status, 'blocked')
    assert.ok(
      preview.blockers.some(item => item.code === 'supplier-subscription-required')
    )
  })

  test('blocca con NON RINNOVARE', () => {
    const service = makeService({dontRenew: true})
    const preview = makeReadyPreview(service)

    assert.equal(preview.status, 'blocked')
    assert.ok(preview.blockers.some(item => item.code === 'dont-renew-active'))
  })
})

describe('Proposta ed esecuzione rinnovo completo', () => {
  test('genera una sola proposta con entrambe le sottoscrizioni', () => {
    const service = makeService()
    const {customerSubscription, supplierCandidate} = getSelection(service)
    const result = buildFullRenewalExecutionProposalFromPreview({
      service,
      customerSubscription,
      supplierCandidate,
      preview: makeReadyPreview(service),
      actorToken: 'full-proposal',
    })

    assert.equal(result.intent, 'action-proposal')
    assert.equal(result.data.action.requiresConfirmation, true)
    assert.equal(result.data.action.reversible, false)
    assert.equal(result.data.action.subscriptions.customer.id, 'customer-subscription')
    assert.equal(result.data.action.subscriptions.supplier.id, 'supplier-subscription')
  })

  test('conferma passando stale-state cliente e fornitore', async () => {
    const service = makeService()
    const {customerSubscription, supplierCandidate} = getSelection(service)
    const actorToken = 'full-confirm'
    const proposal = buildFullRenewalExecutionProposalFromPreview({
      service,
      customerSubscription,
      supplierCandidate,
      preview: makeReadyPreview(service),
      actorToken,
    })

    let received = null
    const result = await handleFullRenewalExecutionDecision({
      action: {actionId: proposal.data.action.actionId, decision: 'confirm'},
      actorToken,
      executeFn: async payload => {
        received = payload
        return {
          status: 'completed',
          changed: true,
          idempotent: false,
          service: {id: service.id, flags: {toRenew: false}},
          supplier: {
            subscription: {
              id: 'supplier-subscription',
              previousEndDate: '2027-04-03T12:00:00',
              endsOn: '2028-04-03T12:00:00',
            },
          },
          customer: {
            subscription: {
              id: 'customer-subscription',
              previousEndDate: '2027-03-03T12:00:00',
              endsOn: '2028-03-03T12:00:00',
            },
            plesk: {required: true, updated: true},
          },
          warnings: [],
        }
      },
    })

    assert.equal(result.intent, 'action-result')
    assert.equal(received.serviceId, service.id)
    assert.equal(received.expectedDontRenew, false)
    assert.equal(received.customer.expectedEndDate, '2027-03-03T12:00:00')
    assert.equal(received.customer.newEndDate, '2028-03-03T12:00:00')
    assert.equal(received.supplier.expectedEndDate, '2027-04-03T12:00:00')
    assert.equal(received.supplier.newEndDate, '2028-04-03T12:00:00')
    assert.equal(result.data.result.customer.plesk.updated, true)
  })

  test('annulla senza eseguire', async () => {
    const service = makeService()
    const {customerSubscription, supplierCandidate} = getSelection(service)
    const actorToken = 'full-cancel'
    const proposal = buildFullRenewalExecutionProposalFromPreview({
      service,
      customerSubscription,
      supplierCandidate,
      preview: makeReadyPreview(service),
      actorToken,
    })

    let executed = false
    const result = await handleFullRenewalExecutionDecision({
      action: {actionId: proposal.data.action.actionId, decision: 'cancel'},
      actorToken,
      executeFn: async () => {
        executed = true
      },
    })

    assert.equal(result.data.status, 'cancelled')
    assert.equal(executed, false)
  })

  test('restituisce un action-error valido in caso di stato parziale', async () => {
    const service = makeService()
    const {customerSubscription, supplierCandidate} = getSelection(service)
    const actorToken = 'full-partial'
    const proposal = buildFullRenewalExecutionProposalFromPreview({
      service,
      customerSubscription,
      supplierCandidate,
      preview: makeReadyPreview(service),
      actorToken,
    })

    const result = await handleFullRenewalExecutionDecision({
      action: {actionId: proposal.data.action.actionId, decision: 'confirm'},
      actorToken,
      executeFn: async () => {
        throw new Error('stato parziale: compensazione fallita')
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.intent, 'action-error')
    assert.equal(result.data.error.code, 'full-renewal-partial-failure')
  })
})

describe('Risoluzione rinnovo completo', () => {
  test('preferisce il dominio esatto', async () => {
    const exact = makeService()
    const sameNameWithoutDomain = makeService({
      id: 'service-generic',
      domains_id: null,
      subscriptions: makeService().subscriptions,
    })

    const result = await handleFullRenewalExecutionRequest({
      request: parseFullRenewalExecutionRequest('rinnova completamente eco-pv.it'),
      services: [sameNameWithoutDomain, exact],
      settings: {},
      actorToken: 'full-exact-domain',
      checksLoader,
    })

    assert.equal(result.intent, 'action-proposal')
    assert.equal(result.data.action.target.id, exact.id)
  })

  test('chiede quale fornitore usare e accetta prima', async () => {
    const service = makeService()
    const secondSupplier = makeSupplierSubscription({
      id: 'supplier-subscription-2',
      plan: {
        id: 'supplier-plan-2',
        name: 'Secondo piano',
        duration: 12,
        supplier: {id: 'supplier-2', name: 'Secondo fornitore'},
      },
    })
    service.subscriptions[0].suppliersSubscriptions.push(secondSupplier)
    const actorToken = 'full-supplier-clarification'

    const first = await handleFullRenewalExecutionRequest({
      request: parseFullRenewalExecutionRequest('rinnova completamente eco-pv.it'),
      services: [service],
      settings: {},
      actorToken,
      checksLoader,
    })

    assert.equal(first.intent, 'clarification')

    const second = await handlePendingFullRenewalExecutionClarification({
      message: 'prima',
      services: [service],
      actorToken,
      checksLoader,
    })

    assert.equal(second.intent, 'action-proposal')
    assert.equal(
      second.data.action.subscriptions.supplier.id,
      'supplier-subscription'
    )
  })
})
