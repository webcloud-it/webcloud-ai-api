import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {
  parseEntityMutationRequest,
  planEntityMutationRequest,
} from '../src/modules/facile/renewals/entityMutationPlanner.js'
import {
  buildEntityMutationProposal,
  buildRecentEntityMutationUndoProposal,
  getRecentCompletedEntityMutationContext,
  handlePendingEntityMutationDecisionMessage,
  isRecentEntityMutationUndoRequest,
} from '../src/modules/facile/renewals/entityMutationActions.js'
import {
  isGenericOperationUndoRequest,
  pickLatestCompletedOperation,
} from '../src/modules/facile/renewals/operationUndoResolver.js'

const catalog = {
  plans: [
    {id: 'plan-domprof10', name: 'DomProf10', duration: 12, supplier: {id: 'supplier-webcloud', name: 'Webcloud'}},
  ],
  providers: [
    {id: 'supplier-webcloud', name: 'Webcloud'},
    {id: 'supplier-aruba', name: 'Aruba'},
  ],
  groups: [{id: 'group-zilio', name: 'Zilio Group Srl'}],
  customers: [{id: 'customer-eco', name: 'Consorzio Eco-Pv', group: null}],
  'plan-prices': [
    {
      id: 'price-domprof10-v1',
      name: 'DomProf10 · Listino standard',
      plan: {id: 'plan-domprof10', name: 'DomProf10'},
      priceListVersion: {id: 'price-list-1', name: 'Listino standard', version: 1},
      price: 105,
    },
  ],
}

async function queryCatalog(plan) {
  const rows = catalog[plan.entity] || []
  const filter = plan.filters?.[0]
  const value = String(filter?.value || '').toLowerCase()
  const items = rows.filter(item => {
    if (filter?.field === 'id') return String(item.id) === String(filter.value)
    if (filter?.field === 'plan.name') {
      return String(item?.plan?.name || '').toLowerCase() === value
    }
    return String(item.name || '').toLowerCase() === value
  })
  return {ok: true, entity: plan.entity, operation: plan.operation, items, total: items.length}
}

function previewFn(payload) {
  const expected = {}
  const changes = []
  for (const change of payload.changes) {
    const from = change.field === 'duration'
      ? 12
      : change.field === 'supplier'
        ? 'supplier-webcloud'
        : change.field === 'name'
          ? 'DomProf10'
          : null
    expected[change.field] = from
    changes.push({field: change.field, label: change.field, from, to: change.value})
  }
  return Promise.resolve({
    ok: true,
    status: 'ready',
    target: {id: payload.targetId, name: 'DomProf10', entity: payload.entity, entitySingular: 'piano'},
    expected,
    changes,
    reversible: true,
  })
}

describe('Planner modifiche entità', () => {
  test('riconosce la rinomina di un piano', () => {
    const plan = parseEntityMutationRequest('rinomina il piano DomProf10 in DomProf20')
    assert.equal(plan.entity, 'plans')
    assert.equal(plan.target, 'DomProf10')
    assert.deepEqual(plan.changes, [{field: 'name', value: 'DomProf20'}])
  })

  test('riconosce la modifica della durata', () => {
    const plan = parseEntityMutationRequest('imposta la durata del piano DomProf10 a 24 mesi')
    assert.equal(plan.entity, 'plans')
    assert.equal(plan.target, 'DomProf10')
    assert.deepEqual(plan.changes, [{field: 'duration', value: '24 mesi'}])
  })

  test('riconosce l’assegnazione di un cliente a un gruppo', () => {
    const plan = parseEntityMutationRequest(
      'assegna il cliente Consorzio Eco-Pv al gruppo Zilio Group Srl'
    )

    assert.equal(plan.entity, 'customers')
    assert.equal(plan.target, 'Consorzio Eco-Pv')
    assert.deepEqual(plan.changes, [{field: 'group', value: 'Zilio Group Srl'}])
  })

  test('riconosce il prezzo di un piano in uno specifico listino', () => {
    const plan = parseEntityMutationRequest(
      'imposta il prezzo del piano DomProf10 nel listino Listino standard v.1 a 120 euro'
    )

    assert.equal(plan.entity, 'plan-prices')
    assert.equal(plan.target, 'DomProf10 · Listino standard v.1')
    assert.deepEqual(plan.changes, [{field: 'price', value: '120 euro'}])
  })

  test('valida un piano semantico senza collezioni Directus', async () => {
    const plan = await planEntityMutationRequest({
      message: 'fai durare DomProf10 due anni',
      callLlm: async () => JSON.stringify({
        operation: 'update',
        entity: 'plans',
        target: 'DomProf10',
        changes: [{field: 'duration', value: 24}],
        confidence: 0.98,
      }),
    })

    assert.equal(plan.entity, 'plans')
    assert.equal(plan.source, 'semantic')
    assert.equal(plan.changes[0].field, 'duration')
  })
})

describe('Proposte modifiche entità', () => {
  test('costruisce anteprima con target univoco', async () => {
    const result = await buildEntityMutationProposal({
      plan: parseEntityMutationRequest('imposta la durata del piano DomProf10 a 24 mesi'),
      services: [],
      options: {},
      actorToken: 'proposal-duration',
      queryCatalog,
      previewFn,
    })

    assert.equal(result.intent, 'action-proposal')
    assert.equal(result.data.action.target.id, 'plan-domprof10')
    assert.equal(result.data.action.requiresConfirmation, true)
  })

  test('risolve una relazione tramite il catalogo', async () => {
    let previewPayload = null
    const result = await buildEntityMutationProposal({
      plan: parseEntityMutationRequest('cambia il fornitore del piano DomProf10 in Aruba'),
      services: [],
      options: {},
      actorToken: 'proposal-supplier',
      queryCatalog,
      previewFn: async payload => {
        previewPayload = payload
        return previewFn(payload)
      },
    })

    assert.equal(result.intent, 'action-proposal')
    assert.deepEqual(previewPayload.changes, [{field: 'supplier', value: 'supplier-aruba'}])
  })

  test('risolve un prezzo specifico tramite piano e versione listino', async () => {
    let previewPayload = null
    const result = await buildEntityMutationProposal({
      plan: parseEntityMutationRequest(
        'imposta il prezzo del piano DomProf10 nel listino Listino standard v.1 a 120 euro'
      ),
      services: [],
      options: {},
      actorToken: 'proposal-price',
      queryCatalog,
      previewFn: async payload => {
        previewPayload = payload
        return {
          status: 'ready',
          target: {
            id: payload.targetId,
            name: 'DomProf10 · Listino standard',
            entity: 'plan-prices',
            entitySingular: 'prezzo del piano',
          },
          expected: {price: 105},
          changes: [{field: 'price', label: 'prezzo', from: 105, to: 120}],
          reversible: true,
        }
      },
    })

    assert.equal(result.intent, 'action-proposal')
    assert.equal(previewPayload.targetId, 'price-domprof10-v1')
    assert.deepEqual(previewPayload.changes, [{field: 'price', value: 120}])
  })

  test('conferma la proposta e chiama il commit', async () => {
    const actorToken = 'proposal-confirm'
    await buildEntityMutationProposal({
      plan: parseEntityMutationRequest('imposta la durata del piano DomProf10 a 24 mesi'),
      services: [],
      options: {},
      actorToken,
      queryCatalog,
      previewFn,
    })

    let committed = null
    const result = await handlePendingEntityMutationDecisionMessage({
      message: 'confermo',
      actorToken,
      commitFn: async payload => {
        committed = payload
        return {
          status: 'completed',
          target: {id: 'plan-domprof10', name: 'DomProf10', entitySingular: 'piano'},
          changes: [{field: 'duration', label: 'durata', from: 12, to: 24}],
        }
      },
    })

    assert.equal(result.intent, 'action-result')
    assert.equal(committed.targetId, 'plan-domprof10')
    assert.deepEqual(committed.expected, {duration: 12})

    const completed = getRecentCompletedEntityMutationContext({actorToken})
    assert.equal(completed.entity, 'plans')
    assert.equal(completed.targetId, 'plan-domprof10')
    assert.ok(completed.completedAt > 0)
  })

  test('annulla una proposta senza chiamare il commit', async () => {
    const actorToken = 'proposal-cancel'
    await buildEntityMutationProposal({
      plan: parseEntityMutationRequest('rinomina il piano DomProf10 in DomProf20'),
      services: [],
      options: {},
      actorToken,
      queryCatalog,
      previewFn,
    })

    let committed = false
    const result = await handlePendingEntityMutationDecisionMessage({
      message: 'annulla',
      actorToken,
      commitFn: async () => {
        committed = true
      },
    })

    assert.equal(result.data.status, 'cancelled')
    assert.equal(committed, false)
  })

  test('prepara un undo esplicito dopo una modifica completata', async () => {
    const actorToken = 'proposal-undo'
    await buildEntityMutationProposal({
      plan: parseEntityMutationRequest('imposta la durata del piano DomProf10 a 24 mesi'),
      services: [],
      options: {},
      actorToken,
      queryCatalog,
      previewFn,
    })

    await handlePendingEntityMutationDecisionMessage({
      message: 'confermo',
      actorToken,
      commitFn: async () => ({
        status: 'completed',
        target: {id: 'plan-domprof10', name: 'DomProf10', entitySingular: 'piano'},
        changes: [{field: 'duration', label: 'durata', from: 12, to: 24}],
      }),
    })

    assert.equal(isRecentEntityMutationUndoRequest('annulla l’ultima modifica anagrafica'), true)

    const undo = await buildRecentEntityMutationUndoProposal({
      actorToken,
      previewFn: async payload => ({
        status: 'ready',
        target: {id: payload.targetId, name: 'DomProf10', entity: 'plans', entitySingular: 'piano'},
        expected: {duration: 24},
        changes: [{field: 'duration', label: 'durata', from: 24, to: 12}],
        reversible: true,
      }),
    })

    assert.equal(undo.intent, 'action-proposal')
    assert.equal(undo.data.action.operation, 'undo-entity-update')
  })
})


describe('Risoluzione universale di annulla', () => {
  test('riconosce annulla come richiesta generica sull’ultima operazione', () => {
    assert.equal(isGenericOperationUndoRequest('annulla'), true)
    assert.equal(isGenericOperationUndoRequest('torna indietro'), true)
    assert.equal(isGenericOperationUndoRequest('annulla l’ultima operazione'), true)
  })

  test('non assorbe una richiesta esplicita sulla modifica anagrafica', () => {
    assert.equal(
      isGenericOperationUndoRequest('annulla l’ultima modifica anagrafica'),
      false
    )
    assert.equal(
      isRecentEntityMutationUndoRequest('annulla l’ultima modifica anagrafica'),
      true
    )
  })

  test('seleziona realmente l’operazione completata più recente', () => {
    const latest = pickLatestCompletedOperation([
      {kind: 'service-action', context: {completedAt: 100}},
      {kind: 'entity-mutation', context: {completedAt: 300}},
      {kind: 'customer-renewal', context: {completedAt: 200}},
    ])

    assert.equal(latest.kind, 'entity-mutation')
    assert.equal(latest.context.completedAt, 300)
  })
})
