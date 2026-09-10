import {env} from '../../../config/env.js'
import {callOllamaJson} from '../../../core/providers/ollamaProvider.js'
import {normalizeComparableText} from '../../../utils/text.js'
import {parseWebcamFleetAnalysisRequest} from './queries.js'

const DIMENSIONS = new Set([
  'reseller', 'networkProvider', 'hardwareBrand', 'hardwareModel', 'location',
  'vpn', 'mikrotik', 'encoding', 'monitored',
])
const FILTERS = new Set([
  'online', 'offline', 'stopped', 'stream-offline', 'snapshot-offline',
  'connectivity-offline', 'mikrotik-offline', 'in-use', 'not-in-use',
  'vpn', 'no-vpn', 'mikrotik', 'no-mikrotik', 'reseller', 'encoding',
  'monitored', 'unmonitored', 'snapshot', 'downtime', 'active-downtime',
])
const DIMENSION_LABELS = Object.freeze({
  reseller: 'reseller',
  networkProvider: 'provider di rete',
  hardwareBrand: 'marca hardware',
  hardwareModel: 'modello hardware',
  location: 'località',
  vpn: 'VPN',
  mikrotik: 'MikroTik',
  encoding: 'encoding',
  monitored: 'monitoraggio',
})

function historyData(item = {}) {
  return item?.data || item?.payload || item?.response?.data || item?.result?.data || null
}

function previousFleetAnalysis(history = []) {
  for (const item of [...(Array.isArray(history) ? history : [])].reverse()) {
    if (item?.role !== 'assistant') continue
    const data = historyData(item)
    if (data?.type === 'webcam-fleet-analysis' && data.query) return data
  }
  return null
}

export function normalizeWebcamFleetPlan(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !DIMENSIONS.has(raw.dimension)) return null
  const rawFilters = Array.isArray(raw.filters) ? raw.filters : []
  const filters = [...new Set(rawFilters.filter(filter => FILTERS.has(filter)))].slice(0, 8)
  if (rawFilters.length > 8 || filters.length !== rawFilters.length) return null
  if (raw.filterMode != null && !['all', 'any'].includes(raw.filterMode)) return null
  if (raw.metric != null && !['count', 'percentage'].includes(raw.metric)) return null
  if (raw.direction != null && !['asc', 'desc'].includes(raw.direction)) return null
  const limit = Number(raw.limit)
  if (raw.limit != null && (!Number.isFinite(limit) || limit < 1 || limit > 50)) return null
  return {
    type: 'webcam-fleet-analysis-query',
    dimension: raw.dimension,
    dimensionLabel: DIMENSION_LABELS[raw.dimension],
    filters,
    filterMode: raw.filterMode || 'all',
    metric: raw.metric || 'count',
    direction: raw.direction || 'desc',
    includeZero: raw.includeZero === true,
    limit: Math.trunc(limit || 10),
    source: raw.source === 'semantic' ? 'semantic' : 'deterministic',
  }
}

function isRefinement(message = '', history = []) {
  return Boolean(previousFleetAnalysis(history)) &&
    /^\s*(?:e|ed|ma|ora|adesso|poi|invece|solo|soltanto|considera|confront\w*|compar\w*|raggrupp\w*|ordin\w*|mostra\w*|esclud\w*)\b/i.test(message)
}

export function isWebcamFleetAnalysisCandidate(message = '', history = []) {
  const text = normalizeComparableText(message)
  if (isRefinement(message, history)) return true
  const analytical = /\b(?:analizz\w*|correl\w*|relazione|incidenza|tasso|percentual\w*|distribuz\w*|raggrupp\w*|confront\w*|compar\w*|classific\w*|ranking|miglior\w*|peggior\w*|maggior\w*|minor\w*|piu|meno|spesso|frequen\w*|ricorren\w*|affidabil\w*)\b/i.test(text)
  const dimension = /\b(?:reseller|rivenditor\w*|provider|connettivita|operatore|marc\w*|brand|produttore|modello|localit\w*|comune|zona|vpn|mikrotik|encoding|monitoraggio)\b/i.test(text)
  return analytical && dimension
}

function refinePreviousPlan(message = '', history = []) {
  if (!isRefinement(message, history)) return null
  const previous = previousFleetAnalysis(history)
  const base = normalizeWebcamFleetPlan(previous?.query)
  if (!base) return null
  const direct = parseWebcamFleetAnalysisRequest(message) ||
    parseWebcamFleetAnalysisRequest(`Confronta ${message} per ogni ${base.dimensionLabel} webcam`)
  const text = normalizeComparableText(message)
  const statusMention = /\b(?:online|offline|stream|snapshot|router|connettivita|mikrotik|ferme|bloccate|guaste|monitorat\w*|downtime)\b/i.test(text)
  const filters = direct?.filters?.length
    ? (statusMention ? direct.filters : [...base.filters, ...direct.filters])
    : base.filters
  return normalizeWebcamFleetPlan({
    ...base,
    ...direct,
    filters: [...new Set(filters)],
    metric: /\b(?:percentual\w*|tasso|incidenza)\b/i.test(text) ? 'percentage' : direct?.metric || base.metric,
    direction: /\b(?:meno|minor\w*|piu\s+bass\w*|miglior\w*)\b/i.test(text)
      ? 'asc'
      : /\b(?:piu|maggior\w*|peggior\w*)\b/i.test(text) ? 'desc' : direct?.direction || base.direction,
    includeZero: /\b(?:confront\w*|compar\w*)\b/i.test(text) ? true : direct?.includeZero ?? base.includeZero,
    source: 'deterministic',
  })
}

export async function planWebcamFleetAnalysis({message = '', history = [], callModel = callOllamaJson} = {}) {
  const refined = refinePreviousPlan(message, history)
  if (refined) return refined
  const deterministic = normalizeWebcamFleetPlan(parseWebcamFleetAnalysisRequest(message))
  if (deterministic) return deterministic
  if (!isWebcamFleetAnalysisCandidate(message, history)) return null

  const previous = normalizeWebcamFleetPlan(previousFleetAnalysis(history)?.query)
  try {
    const raw = await callModel({
      timeoutMs: Math.min(Math.max(env.ollamaReadPlannerTimeoutMs, 6000), 12000),
      options: {temperature: 0, num_predict: 260},
      messages: [
        {
          role: 'system',
          content: [
            'Sei un planner di sola lettura per analisi aggregate della flotta WebcamGo.',
            'Non rispondere alla domanda: restituisci soltanto il piano JSON.',
            `dimension ammesse: ${[...DIMENSIONS].join(', ')}.`,
            `filters ammessi: ${[...FILTERS].join(', ')}.`,
            'filterMode: all o any. metric: count o percentage. direction: asc o desc.',
            'includeZero deve essere true nei confronti tra gruppi. limit deve essere tra 1 e 50.',
            'I calcoli saranno eseguiti dal backend: non stimare risultati e non inventare campi.',
            previous ? `Piano precedente da raffinare, se la richiesta è un seguito: ${JSON.stringify(previous)}` : '',
            'Schema: {"dimension":"...","filters":[],"filterMode":"all","metric":"percentage","direction":"desc","includeZero":false,"limit":10}.',
          ].filter(Boolean).join(' '),
        },
        {role: 'user', content: String(message).slice(0, 1200)},
      ],
    })
    const plan = normalizeWebcamFleetPlan(raw)
    return plan ? {...plan, source: 'semantic'} : null
  } catch {
    return null
  }
}
