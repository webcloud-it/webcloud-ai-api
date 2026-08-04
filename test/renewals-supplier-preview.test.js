import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {parseRenewalExecutionRequest} from '../src/modules/facile/renewals/renewalExecution.js'
import {parseRenewalPreviewRequest} from '../src/modules/facile/renewals/renewalPreview.js'
import {
  buildSupplierRenewalPreviewPayload,
  getSupplierRenewalCandidates,
  handlePendingSupplierRenewalPreviewClarification,
  handleSupplierRenewalPreviewRequest,
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

describe('Parser anteprima rinnovo fornitore', () => {
  test('riconosce il rinnovo fornitore con dominio', () => {
    const request = parseSupplierRenewalPreviewRequest(
      'rinnova la sottoscrizione fornitore di webcloud.it'
    )

    assert.equal(request?.type, 'renewals-supplier-renewal-preview-request')
    assert.equal(request?.mode, 'renew-by-plan-duration')
    assert.equal(request?.namedTarget, 'webcloud.it')
  })

  test('riconosce l’allineamento alla scadenza cliente', () => {
    const request = parseSupplierRenewalPreviewRequest(
      'allinea la scadenza fornitore alla nuova scadenza cliente'
    )

    assert.equal(request?.mode, 'align-customer-expiry')
    assert.equal(request?.selectorSource, 'context')
  })

  test('riconosce il riferimento alla lista precedente', () => {
    const request = parseSupplierRenewalPreviewRequest(
      'prepara il rinnovo della sottoscrizione fornitore del secondo'
    )

    assert.equal(request?.selector?.kind, 'position')
    assert.equal(request?.selector?.position, 2)
  })

  test('non viene intercettato dal rinnovo cliente reale', () => {
    assert.equal(
      parseRenewalExecutionRequest('rinnova la sottoscrizione fornitore di webcloud.it'),
      null
    )
  })

  test('non viene intercettato dall’anteprima rinnovo cliente', () => {
    assert.equal(
      parseRenewalPreviewRequest('prepara il rinnovo della sottoscrizione fornitore di webcloud.it'),
      null
    )
  })
})

describe('Candidati sottoscrizione fornitore', () => {
  test('estrae le sottoscrizioni annidate e mantiene il cliente collegato', () => {
    const service = makeService()
    const candidates = getSupplierRenewalCandidates(service)

    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].subscription.id, 'supplier-subscription-register')
    assert.equal(candidates[0].customerSubscription.id, 'customer-subscription')
  })

  test('non duplica una sottoscrizione presente anche a livello diretto', () => {
    const service = makeService()
    service.subscriptions.push(service.subscriptions[0].suppliersSubscriptions[0])

    assert.equal(getSupplierRenewalCandidates(service).length, 1)
  })
})

describe('Payload anteprima rinnovo fornitore', () => {
  test('calcola la nuova scadenza dalla durata del piano', () => {
    const service = makeService()
    const candidate = getSupplierRenewalCandidates(service)[0]
    const payload = buildSupplierRenewalPreviewPayload({
      service,
      supplierSubscription: candidate.subscription,
      customerSubscription: candidate.customerSubscription,
      mode: 'renew-by-plan-duration',
    })

    assert.equal(payload.status, 'ready')
    assert.equal(payload.previewOnly, true)
    assert.equal(payload.executionAllowed, false)
    assert.equal(payload.supplierSubscription.proposedEndDate, '2028-02-15T12:00:00')
    assert.equal(payload.externalSupplier.name, 'MisterDomain')
  })

  test('allinea la scadenza fornitore alla scadenza cliente', () => {
    const service = makeService()
    const candidate = getSupplierRenewalCandidates(service)[0]
    const payload = buildSupplierRenewalPreviewPayload({
      service,
      supplierSubscription: candidate.subscription,
      customerSubscription: candidate.customerSubscription,
      mode: 'align-customer-expiry',
    })

    assert.equal(payload.status, 'ready')
    assert.equal(payload.supplierSubscription.proposedEndDate, '2028-02-13T12:00:00')
  })

  test('blocca con NON RINNOVARE attivo', () => {
    const service = makeService({dontRenew: true})
    const candidate = getSupplierRenewalCandidates(service)[0]
    const payload = buildSupplierRenewalPreviewPayload({
      service,
      supplierSubscription: candidate.subscription,
      customerSubscription: candidate.customerSubscription,
    })

    assert.equal(payload.status, 'blocked')
    assert.ok(payload.blockers.some(item => item.code === 'dont-renew-active'))
  })

  test('blocca il rinnovo quando manca la durata del piano fornitore', () => {
    const service = makeService()
    service.subscriptions[0].suppliersSubscriptions[0].plan.duration = null
    const candidate = getSupplierRenewalCandidates(service)[0]
    const payload = buildSupplierRenewalPreviewPayload({
      service,
      supplierSubscription: candidate.subscription,
      customerSubscription: candidate.customerSubscription,
      mode: 'renew-by-plan-duration',
    })

    assert.equal(payload.status, 'blocked')
    assert.ok(
      payload.blockers.some(item => item.code === 'supplier-plan-duration-missing')
    )
  })

  test('avvisa quando il rinnovo fornitore resta precedente al cliente', () => {
    const service = makeService()
    service.subscriptions[0].endsOn = '2029-02-13T12:00:00'
    const candidate = getSupplierRenewalCandidates(service)[0]
    const payload = buildSupplierRenewalPreviewPayload({
      service,
      supplierSubscription: candidate.subscription,
      customerSubscription: candidate.customerSubscription,
      mode: 'renew-by-plan-duration',
    })

    assert.ok(
      payload.warnings.some(item => item.code === 'supplier-expiry-before-customer-expiry')
    )
  })
})

describe('Risoluzione e chiarimenti rinnovo fornitore', () => {
  test('preferisce il dominio esatto', async () => {
    const request = parseSupplierRenewalPreviewRequest(
      'rinnova la sottoscrizione fornitore di webcloud.it'
    )
    const result = await handleSupplierRenewalPreviewRequest({
      request,
      services: [
        makeService(),
        makeService({
          id: 'service-without-domain',
          name: 'webcloud.it',
          domains_id: null,
        }),
      ],
      settings: {},
      history: [],
      scope: {},
      actorToken: 'supplier-preview-exact-domain',
    })

    assert.equal(result.intent, 'supplier-renewal-preview')
    assert.equal(result.data.service.id, 'service-webcloud-it')
  })

  test('usa il servizio recente per una richiesta contestuale', async () => {
    const request = parseSupplierRenewalPreviewRequest(
      'allinea la scadenza fornitore alla nuova scadenza cliente'
    )
    const result = await handleSupplierRenewalPreviewRequest({
      request,
      services: [makeService()],
      settings: {},
      history: [],
      scope: {},
      actorToken: 'supplier-preview-context',
      recentServiceId: 'service-webcloud-it',
    })

    assert.equal(result.intent, 'supplier-renewal-preview')
    assert.equal(result.data.mode, 'align-customer-expiry')
  })

  test('chiede quale fornitore usare e accetta la risposta numerica', async () => {
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

    const actorToken = 'supplier-preview-clarification'
    const first = await handleSupplierRenewalPreviewRequest({
      request: parseSupplierRenewalPreviewRequest(
        'rinnova la sottoscrizione fornitore di webcloud.it'
      ),
      services: [service],
      settings: {},
      history: [],
      scope: {},
      actorToken,
    })

    assert.equal(first.intent, 'clarification')

    const second = await handlePendingSupplierRenewalPreviewClarification({
      message: '2',
      services: [service],
      actorToken,
    })

    assert.equal(second.intent, 'supplier-renewal-preview')
    assert.equal(second.data.supplierSubscription.id, 'supplier-subscription-second')
  })
})
