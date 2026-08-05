import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {verifyCompletedOperationResult} from '../src/modules/facile/renewals/operationVerification.js'

function makeService(overrides = {}) {
  return {
    id: 'service-1',
    name: 'eco-pv.it',
    toRenew: false,
    dontRenew: false,
    autoRenew: false,
    toTransfer: null,
    invoiceDate: null,
    pleskPlansSync: true,
    domains_id: {id: 'domain-1', name: 'eco-pv.it'},
    subscriptions: [
      {
        id: 'customer-subscription',
        isSupplier: false,
        endsOn: '2028-03-03T12:00:00',
        suppliersSubscriptions: [
          {
            id: 'supplier-subscription',
            isSupplier: true,
            endsOn: '2028-04-03T12:00:00',
          },
        ],
      },
    ],
    ...overrides,
  }
}

function makeServiceActionResult(changes = []) {
  return {
    ok: true,
    intent: 'action-result',
    reply: 'Operazione completata.',
    data: {
      type: 'action-result',
      action: {
        actionId: 'action-1',
        target: {id: 'service-1', label: 'eco-pv.it'},
        changes,
      },
      result: {status: 'completed', changed: true, service: {id: 'service-1'}},
    },
  }
}

describe('Verifica post-operazione', () => {
  test('conferma una modifica ai flag riletta dai servizi', async () => {
    const result = await verifyCompletedOperationResult({
      result: makeServiceActionResult([
        {field: 'dontRenew', label: 'NON RINNOVARE', from: false, to: true},
      ]),
      loadServices: async () => [makeService({dontRenew: true})],
    })

    assert.equal(result.data.status, 'completed-and-verified')
    assert.equal(result.data.verification.checks[0].ok, true)
    assert.match(result.reply, /Verifica successiva completata/i)
  })

  test('segnala una discordanza dopo una modifica ai servizi', async () => {
    const result = await verifyCompletedOperationResult({
      result: makeServiceActionResult([
        {field: 'dontRenew', label: 'NON RINNOVARE', from: false, to: true},
      ]),
      loadServices: async () => [makeService({dontRenew: false})],
    })

    assert.equal(result.data.status, 'verification-failed')
    assert.equal(result.data.verification.checks[0].ok, false)
    assert.match(result.reply, /controllo manuale/i)
  })

  test('verifica la scadenza di una sottoscrizione', async () => {
    const result = await verifyCompletedOperationResult({
      result: {
        ok: true,
        intent: 'action-result',
        reply: 'Rinnovo completato.',
        data: {
          type: 'action-result',
          result: {
            status: 'completed',
            service: {id: 'service-1', flags: {toRenew: false}},
            subscription: {
              id: 'customer-subscription',
              endsOn: '2028-03-03T12:00:00',
            },
            plesk: {required: false, updated: false},
          },
        },
      },
      loadServices: async () => [makeService()],
    })

    assert.equal(result.data.status, 'completed-and-verified')
    assert.equal(result.data.verification.checks.length, 2)
    assert.equal(result.data.verification.checks.every(check => check.ok), true)
  })

  test('verifica cliente, fornitore e Plesk nel rinnovo completo', async () => {
    const result = await verifyCompletedOperationResult({
      result: {
        ok: true,
        intent: 'action-result',
        reply: 'Rinnovo completo eseguito.',
        data: {
          type: 'action-result',
          result: {
            status: 'completed',
            service: {id: 'service-1', flags: {toRenew: false}},
            customer: {
              subscription: {id: 'customer-subscription', endsOn: '2028-03-03T12:00:00'},
              plesk: {required: true, updated: true},
            },
            supplier: {
              subscription: {id: 'supplier-subscription', endsOn: '2028-04-03T12:00:00'},
            },
          },
        },
      },
      loadServices: async () => [makeService()],
      auditPlesk: async () => ({items: []}),
    })

    assert.equal(result.data.status, 'completed-and-verified')
    assert.equal(result.data.verification.checks.length, 4)
    assert.equal(result.data.verification.checks.at(-1).field, 'plesk')
  })

  test('mantiene completata con avviso se l’audit Plesk non è disponibile', async () => {
    const result = await verifyCompletedOperationResult({
      result: {
        ok: true,
        intent: 'action-result',
        reply: 'Rinnovo completato.',
        data: {
          type: 'action-result',
          result: {
            status: 'completed',
            service: {id: 'service-1'},
            subscription: {id: 'customer-subscription', endsOn: '2028-03-03T12:00:00'},
            plesk: {required: true, updated: true},
          },
        },
      },
      loadServices: async () => [makeService()],
      auditPlesk: async () => {
        throw new Error('audit non disponibile')
      },
    })

    assert.equal(result.data.status, 'completed-with-warning')
    assert.equal(result.data.verification.checks[0].ok, true)
    assert.equal(result.data.verification.warnings[0].code, 'plesk-verification-failed')
  })

  test('verifica una modifica del catalogo con una rilettura per ID', async () => {
    let receivedPlan = null
    const result = await verifyCompletedOperationResult({
      result: {
        ok: true,
        intent: 'action-result',
        reply: 'Modifica completata.',
        data: {
          type: 'action-result',
          result: {
            type: 'renewals-catalog-mutation-result',
            status: 'completed',
            target: {id: 'plan-1', name: 'DomProf10', entity: 'plans'},
            changes: [{field: 'duration', label: 'durata', from: 12, to: 24}],
          },
        },
      },
      queryCatalog: async plan => {
        receivedPlan = plan
        return {ok: true, items: [{id: 'plan-1', name: 'DomProf10', duration: 24}]}
      },
    })

    assert.equal(receivedPlan.entity, 'plans')
    assert.deepEqual(receivedPlan.filters, [
      {field: 'id', operator: 'equals', value: 'plan-1'},
    ])
    assert.equal(result.data.status, 'completed-and-verified')
  })

  test('non modifica proposte e annullamenti', async () => {
    const proposal = {
      ok: true,
      intent: 'action-proposal',
      data: {type: 'action-preview'},
    }

    const result = await verifyCompletedOperationResult({result: proposal})
    assert.equal(result, proposal)
  })
})
