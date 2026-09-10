import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeWebcamFleetPlan,
  planWebcamFleetAnalysis,
} from '../src/modules/facile/webcamgo/fleetPlanner.js'

test('il fast path pianifica analisi WebcamGo anche senza ripetere la parola webcam', async () => {
  let modelCalls = 0
  const plan = await planWebcamFleetAnalysis({
    message: 'Confronta il tasso di stream offline per provider di rete',
    callModel: async () => {
      modelCalls += 1
      return {}
    },
  })

  assert.equal(modelCalls, 0)
  assert.equal(plan.dimension, 'networkProvider')
  assert.deepEqual(plan.filters, ['stream-offline'])
  assert.equal(plan.metric, 'percentage')
  assert.equal(plan.includeZero, true)
})

test('il planner semantico traduce formulazioni analitiche nuove in un piano validato', async () => {
  const plan = await planWebcamFleetAnalysis({
    message: 'Esiste una relazione tra i guasti dello stream e l’operatore di connettività?',
    callModel: async () => ({
      dimension: 'networkProvider',
      filters: ['stream-offline'],
      filterMode: 'all',
      metric: 'percentage',
      direction: 'desc',
      includeZero: true,
      limit: 10,
    }),
  })

  assert.equal(plan.source, 'semantic')
  assert.equal(plan.dimension, 'networkProvider')
  assert.deepEqual(plan.filters, ['stream-offline'])
})

test('il fallback semantico intercetta confronti naturali senza verbi tecnici', async () => {
  for (const message of [
    'Quali marche sembrano soffrire maggiormente di snapshot bloccati?',
    'Le telecamere con VPN risultano meno spesso offline?',
  ]) {
    let called = false
    const plan = await planWebcamFleetAnalysis({
      message,
      callModel: async () => {
        called = true
        return {dimension: 'hardwareBrand', filters: ['snapshot-offline'], metric: 'percentage', direction: 'desc', limit: 10}
      },
    })
    assert.equal(called, true)
    assert.equal(plan.source, 'semantic')
  }
})

test('il planner semantico rifiuta campi inventati invece di eseguirli', async () => {
  const plan = await planWebcamFleetAnalysis({
    message: 'Esiste una relazione tra i guasti e il provider?',
    callModel: async () => ({
      dimension: 'providerSegreto',
      filters: ['password-esposta'],
      metric: 'percentage',
      direction: 'desc',
      limit: 10,
    }),
  })

  assert.equal(plan, null)
})

test('un follow-up cambia raggruppamento mantenendo il filtro verificato precedente', async () => {
  const history = [{
    role: 'assistant',
    data: {
      type: 'webcam-fleet-analysis',
      query: normalizeWebcamFleetPlan({
        dimension: 'reseller',
        filters: ['offline'],
        metric: 'percentage',
        direction: 'desc',
        limit: 10,
      }),
    },
  }]
  const plan = await planWebcamFleetAnalysis({message: 'Ora raggruppale per località', history})

  assert.equal(plan.dimension, 'location')
  assert.deepEqual(plan.filters, ['offline'])
})

test('un follow-up cambia il guasto analizzato senza perdere la dimensione', async () => {
  const history = [{
    role: 'assistant',
    data: {
      type: 'webcam-fleet-analysis',
      query: normalizeWebcamFleetPlan({
        dimension: 'networkProvider',
        filters: ['stream-offline'],
        metric: 'percentage',
        direction: 'desc',
        limit: 10,
      }),
    },
  }]
  const plan = await planWebcamFleetAnalysis({message: 'Adesso considera soltanto lo snapshot offline', history})

  assert.equal(plan.dimension, 'networkProvider')
  assert.deepEqual(plan.filters, ['snapshot-offline'])
})
