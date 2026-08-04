import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {
  addMonthsPreservingDay,
  buildRenewalPreviewPayload,
  handlePendingRenewalPreviewClarification,
  handleRenewalPreviewRequest,
  parseRenewalPreviewRequest,
} from '../src/modules/facile/renewals/renewalPreview.js'

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
    dontRenew: false,
    autoRenew: false,
    toRenew: true,
    toTransfer: null,
    pleskPlansSync: true,
    authCode: 'SEGRETO-DA-NON-MOSTRARE',
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
        addons: [{id: 'addon-ssl', name: 'SSL', missingPrice: false}],
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
            addons: [],
          },
        ],
      },
    ],
    ...overrides,
  }
}

describe('Parser anteprima rinnovo', () => {
  test('riconosce la richiesta esplicita con dominio', () => {
    const request = parseRenewalPreviewRequest('prepara il rinnovo di eco-pv.it')

    assert.equal(request?.type, 'renewals-renewal-preview-request')
    assert.equal(request?.namedTarget, 'eco-pv.it')
  })

  test('riconosce il riferimento alla lista precedente', () => {
    const request = parseRenewalPreviewRequest('simula il rinnovo del secondo')

    assert.equal(request?.selector?.kind, 'position')
    assert.equal(request?.selector?.position, 2)
  })

  test('non intercetta una normale lista', () => {
    assert.equal(parseRenewalPreviewRequest('tutti i servizi da rinnovare'), null)
  })

  test('non trasforma un rinnovo reale in anteprima senza un verbo di simulazione', () => {
    assert.equal(parseRenewalPreviewRequest('rinnova eco-pv.it'), null)
  })
})

describe('Calcolo nuova scadenza', () => {
  test('aggiunge la durata del piano alla scadenza corrente', () => {
    const result = addMonthsPreservingDay('2027-03-03T12:00:00', 12)

    assert.equal(result.getFullYear(), 2028)
    assert.equal(result.getMonth(), 2)
    assert.equal(result.getDate(), 3)
  })

  test('gestisce correttamente la fine del mese', () => {
    const result = addMonthsPreservingDay('2027-01-31T12:00:00', 1)

    assert.equal(result.getFullYear(), 2027)
    assert.equal(result.getMonth(), 1)
    assert.equal(result.getDate(), 28)
  })
})

describe('Payload anteprima rinnovo', () => {
  test('costruisce una proposta pronta senza modificare dati', () => {
    const service = makeService()
    const payload = buildRenewalPreviewPayload({
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

    assert.equal(payload.status, 'ready')
    assert.equal(payload.previewOnly, true)
    assert.equal(payload.executionAllowed, false)
    assert.match(payload.customerSubscription.proposedEndDate, /^2028-03-03T12:00:00/)
    assert.equal(payload.customerSubscription.plan.name, 'DomProf170 NoSSL')
    assert.equal(payload.supplierSubscriptions[0].plan.supplier.name, 'Register')
    assert.equal(payload.flags.authCodeSet, true)
    assert.doesNotMatch(JSON.stringify(payload), /SEGRETO-DA-NON-MOSTRARE/)
  })

  test('blocca il rinnovo quando è attivo NON RINNOVARE', () => {
    const service = makeService({dontRenew: true})
    const payload = buildRenewalPreviewPayload({
      service,
      customerSubscription: service.subscriptions[0],
    })

    assert.equal(payload.status, 'blocked')
    assert.ok(payload.blockers.some(item => item.code === 'dont-renew-active'))
  })

  test('blocca il calcolo quando manca la durata del piano', () => {
    const service = makeService()
    service.subscriptions[0].plan.duration = null

    const payload = buildRenewalPreviewPayload({
      service,
      customerSubscription: service.subscriptions[0],
    })

    assert.equal(payload.status, 'blocked')
    assert.equal(payload.customerSubscription.proposedEndDate, null)
    assert.ok(payload.blockers.some(item => item.code === 'plan-duration-missing'))
  })

  test('trasforma un errore Plesk in blocco e un errore HTTP in avviso', () => {
    const service = makeService()
    const payload = buildRenewalPreviewPayload({
      service,
      customerSubscription: service.subscriptions[0],
      pleskAudit: {
        items: [
          {
            severity: 'error',
            code: 'expiration_mismatch',
            title: 'Scadenza CRM/Plesk diversa',
            service: {id: service.id},
          },
        ],
      },
      httpCheck: {checked: true, ok: false, status: 503},
    })

    assert.ok(payload.blockers.some(item => item.code === 'expiration_mismatch'))
    assert.ok(payload.warnings.some(item => item.code === 'http-check-failed'))
  })
})

describe('Risoluzione e chiarimenti', () => {
  test('preferisce il dominio esatto e restituisce una anteprima', async () => {
    const request = parseRenewalPreviewRequest('prepara il rinnovo di eco-pv.it')
    const result = await handleRenewalPreviewRequest({
      request,
      services: [
        makeService(),
        makeService({
          id: 'other-service',
          name: 'eco-pv.it',
          domains_id: null,
          pleskDomain: null,
        }),
      ],
      settings: {},
      history: [],
      scope: {},
      actorToken: 'preview-exact-domain',
    })

    assert.equal(result.intent, 'renewal-preview')
    assert.equal(result.data.service.id, 'service-eco-pv')
    assert.equal(result.data.previewOnly, true)
  })

  test('chiede quale sottoscrizione usare e accetta una risposta numerica', async () => {
    const service = makeService()
    service.subscriptions.push({
      ...service.subscriptions[0],
      id: 'customer-subscription-2',
      endsOn: '2027-06-01T12:00:00',
      plan: {
        ...service.subscriptions[0].plan,
        id: 'customer-plan-2',
        name: 'Secondo piano',
      },
    })

    const actorToken = 'preview-subscription-choice'
    const first = await handleRenewalPreviewRequest({
      request: parseRenewalPreviewRequest('prepara il rinnovo di eco-pv.it'),
      services: [service],
      settings: {},
      history: [],
      scope: {},
      actorToken,
    })

    assert.equal(first.intent, 'clarification')

    const second = await handlePendingRenewalPreviewClarification({
      message: '2',
      services: [service],
      actorToken,
    })

    assert.equal(second.intent, 'renewal-preview')
    assert.equal(second.data.customerSubscription.id, 'customer-subscription-2')
  })
})
