import {callOllamaChat} from '../../../core/providers/ollamaProvider.js'
import {env} from '../../../config/env.js'
import {
  DEFAULT_READ_QUERY_LIMIT,
  mergeReadQueryPlans,
  validateReadQueryPlan,
} from './readQueryContract.js'
import {
  findReadEntityByAlias,
  findReadEntityFieldByAlias,
  getReadEntityDefinitions,
  getReadEntityRegistry,
} from './readEntityRegistry.js'
import {buildReadQueryDetailReference} from './readQueryReferences.js'
import {getRememberedReadQueryContext} from './readQueryContext.js'

function normalizeText(value = '') {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}


const READ_QUERY_PLAN_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    operation: {
      type: 'string',
      enum: ['list', 'count', 'detail', 'aggregate', 'unknown'],
    },
    entity: {
      anyOf: [{type: 'string'}, {type: 'null'}],
    },
    filters: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          field: {type: 'string'},
          operator: {
            type: 'string',
            enum: [
              'equals',
              'not-equals',
              'contains',
              'not-contains',
              'in',
              'between',
              'gte',
              'lte',
              'exists',
              'not-exists',
              'truthy',
              'falsey',
            ],
          },
          value: {},
        },
        required: ['field', 'operator', 'value'],
      },
    },
    groupBy: {
      type: 'array',
      maxItems: 2,
      items: {type: 'string'},
    },
    metrics: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {type: 'string'},
          function: {
            type: 'string',
            enum: ['count', 'count-distinct', 'sum', 'avg', 'min', 'max'],
          },
          field: {
            anyOf: [{type: 'string'}, {type: 'null'}],
          },
        },
        required: ['id', 'function', 'field'],
      },
    },
    sort: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          field: {type: 'string'},
          direction: {type: 'string', enum: ['asc', 'desc']},
        },
        required: ['field', 'direction'],
      },
    },
    limit: {type: 'integer', minimum: 0, maximum: 50},
    offset: {type: 'integer', minimum: 0},
    confidence: {type: 'number', minimum: 0, maximum: 1},
  },
  required: [
    'operation',
    'entity',
    'filters',
    'groupBy',
    'metrics',
    'sort',
    'limit',
    'offset',
    'confidence',
  ],
})

const ANALYTICAL_READ_PATTERN =
  /\b(?:raggrupp\w*|aggreg\w*|classific\w*|ranking|top|maggior\w*|minor\w*|massim\w*|minim\w*|medi[ae]?|somm\w*|distint\w*|distribuz\w*|confront\w*|correl\w*|per\s+(?:ogni|ciascun\w*)|piu|meno|prim[ei]\s+(?:\d{1,2}|un[oa]?|due|tre|quattro|cinque|sei|sette|otto|nove|dieci))\b/i

export function isAnalyticalReadQueryRequest(message = '') {
  const text = normalizeText(message)
  if (!text) return false

  return (
    ANALYTICAL_READ_PATTERN.test(text) ||
    /\b(?:quanti|quante|conteggio|numero)\b[\s\S]{0,80}\bper\b/i.test(text) ||
    /\bper\b[\s\S]{0,80}\b(?:quanti|quante|conteggio|numero)\b/i.test(text)
  )
}

export function checkAnalyticalReadPlannerReadiness() {
  const message = 'Quali fornitori hanno più servizi in scadenza nel 2027?'
  const candidate = buildDeterministicAnalyticalPlan(message)
  const validation = validateReadQueryPlan(candidate || {}, getReadEntityRegistry())
  const plan = validation.plan || null
  const ok =
    validation.ok === true &&
    plan?.operation === 'aggregate' &&
    plan?.entity === 'subscriptions' &&
    plan?.groupBy?.[0] === 'supplier.name' &&
    plan?.metrics?.[0]?.function === 'count-distinct' &&
    plan?.metrics?.[0]?.field === 'service.id'

  return {
    ok,
    signature: ok
      ? 'subscriptions:supplier.name:count-distinct(service.id)'
      : null,
    reason: ok ? null : validation.reason || 'unexpected-plan',
  }
}


function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getAnalyticalFieldTerms(fieldId = '', config = {}) {
  return [...new Set([
    fieldId,
    config?.label,
    ...(Array.isArray(config?.aliases) ? config.aliases : []),
  ])]
    .filter(Boolean)
    .map(value => normalizeText(value))
    .filter(Boolean)
    .sort((first, second) => second.length - first.length)
}

function getAnalyticalEntityDefinition(entityId = '') {
  return getReadEntityDefinitions().find(definition => definition.id === entityId) || null
}

function findGroupingField(definition = null, message = '') {
  if (!definition) return null
  const text = normalizeText(message)
  const matches = []

  for (const [fieldId, config] of Object.entries(definition.fields || {})) {
    for (const term of getAnalyticalFieldTerms(fieldId, config)) {
      const escaped = escapeRegExp(term)
      const explicitPer = new RegExp(
        `\\bper\\s+(?:(?:ogni|ciascun\\w*)\\s+)?(?:(?:il|lo|la|i|gli|le|un|una)\\s+)?${escaped}\\b`,
        'i'
      )
      const explicitGroup = new RegExp(
        `\\b(?:raggrupp\\w*|divid\\w*|suddivid\\w*)\\b[\\s\\S]{0,90}\\b${escaped}\\b`,
        'i'
      )

      if (!explicitPer.test(text) && !explicitGroup.test(text)) continue
      matches.push({field: fieldId, termLength: term.length})
      break
    }
  }

  matches.sort((first, second) => second.termLength - first.termLength)
  if (!matches.length) return null
  const best = matches[0]
  return matches.filter(item => item.termLength === best.termLength && item.field !== best.field).length
    ? null
    : best.field
}

function findRankingField(definition = null, message = '') {
  if (!definition) return null
  const text = normalizeText(message)
  const candidates = []

  for (const [fieldId, config] of Object.entries(definition.fields || {})) {
    if (config?.type !== 'number') continue

    for (const term of getAnalyticalFieldTerms(fieldId, config)) {
      const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i')
      if (!pattern.test(text)) continue
      candidates.push({field: fieldId, termLength: term.length})
      break
    }
  }

  candidates.sort((first, second) => second.termLength - first.termLength)
  if (!candidates.length) return null
  const best = candidates[0]
  return candidates.filter(item => item.termLength === best.termLength && item.field !== best.field).length
    ? null
    : best.field
}

function extractAnalyticalLimit(message = '', definition = null) {
  const text = normalizeText(message)
  const normalLimit = extractLimit(text)
  if (normalLimit !== DEFAULT_READ_QUERY_LIMIT) return normalLimit

  const top = text.match(/\btop\s+(\d{1,2})\b/i)
  if (top?.[1]) return Math.min(Math.max(Number(top[1]), 1), 50)

  const entityTerms = definition
    ? [definition.label, definition.singular, ...(definition.aliases || [])]
        .filter(Boolean)
        .map(value => normalizeText(value))
        .sort((first, second) => second.length - first.length)
    : []

  for (const term of entityTerms) {
    const match = text.match(new RegExp(`\\b(\\d{1,2})\\s+${escapeRegExp(term)}\\b`, 'i'))
    if (match?.[1]) return Math.min(Math.max(Number(match[1]), 1), 50)
  }

  return DEFAULT_READ_QUERY_LIMIT
}

function getEntitySemanticTerms(definition = null) {
  if (!definition) return []

  return [...new Set([
    definition.id,
    definition.label,
    definition.singular,
    ...(definition.aliases || []),
  ])]
    .filter(Boolean)
    .map(value => normalizeText(value))
    .filter(Boolean)
    .sort((first, second) => second.length - first.length)
}

function findEntityMention(definition = null, message = '') {
  const text = normalizeText(message)
  const matches = getEntitySemanticTerms(definition)
    .map(term => {
      const match = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').exec(text)
      return match ? {index: match.index, termLength: term.length} : null
    })
    .filter(Boolean)
    .sort((first, second) => first.index - second.index || second.termLength - first.termLength)

  return matches[0] || null
}

function findRelationDimension(measureDefinition = null, targetDefinition = null) {
  if (!measureDefinition || !targetDefinition) return null

  const targetTerms = new Set(getEntitySemanticTerms(targetDefinition))
  const matches = Object.entries(measureDefinition.fields || {})
    .filter(([, config]) => ['string', 'string-array'].includes(config?.type))
    .map(([field, config]) => {
      const overlap = getAnalyticalFieldTerms(field, config)
        .filter(term => targetTerms.has(term))
        .sort((first, second) => second.length - first.length)

      return overlap.length ? {field, score: overlap[0].length} : null
    })
    .filter(Boolean)
    .sort((first, second) => second.score - first.score)

  if (!matches.length) return null
  if (matches.length > 1 && matches[0].score === matches[1].score) return null
  return matches[0].field
}

function mergeAnalyticalFilters(...sources) {
  const filters = sources.flat().filter(Boolean)
  const seen = new Set()

  return filters.filter(filter => {
    const key = JSON.stringify([filter.field, filter.operator, filter.value])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function findRelationalFact(definitions = [], target = null, measure = null) {
  if (!target || !measure) return null

  return definitions
    .map(definition => {
      const targetRelation = definition.analytics?.relations?.[target.id]
      const measureRelation = definition.analytics?.relations?.[measure.id]
      if (!targetRelation?.labelField || !measureRelation?.idField) return null

      const fields = definition.fields || {}
      if (!fields[targetRelation.labelField] || !fields[measureRelation.idField]) return null

      return {
        definition,
        targetRelation,
        measureRelation,
        score: definition.analytics?.timeField ? 1 : 0,
      }
    })
    .filter(Boolean)
    .sort((first, second) => second.score - first.score)[0] || null
}

function buildRelationalRankingPlan(message = '', previousState = null) {
  const text = normalizeText(message)
  const direction = /\b(?:piu|maggior\w*|massim\w*|top)\b/i.test(text)
    ? 'desc'
    : /\b(?:meno|minor\w*|minim\w*)\b/i.test(text)
      ? 'asc'
      : null

  if (!direction) return null
  if (/\b(?:esclud\w*|tranne|eccetto|confront\w*|rispetto)\b/i.test(text)) return null

  const definitions = getReadEntityDefinitions()
  const mentions = definitions
    .map(definition => ({definition, mention: findEntityMention(definition, text)}))
    .filter(item => item.mention)
    .sort((first, second) =>
      first.mention.index - second.mention.index ||
      second.mention.termLength - first.mention.termLength
    )

  const target = mentions[0]?.definition || null
  const measure = mentions.find(item =>
    item.definition.id !== target?.id && item.mention.index > mentions[0].mention.index
  )?.definition || null

  if (!target || !measure) return null

  const relationalFact = findRelationalFact(definitions, target, measure)
  if (relationalFact) {
    const dimension = relationalFact.targetRelation.labelField
    const filters = mergeAnalyticalFilters(
      buildDeterministicFilters(relationalFact.definition.id, text)
        .filter(filter => filter.field !== dimension),
      relationalFact.targetRelation.filters || [],
      relationalFact.measureRelation.filters || []
    )

    return {
      type: 'read-query-plan',
      operation: 'aggregate',
      entity: relationalFact.definition.id,
      filters,
      groupBy: [dimension],
      metrics: [{
        id: 'count',
        function: 'count-distinct',
        field: relationalFact.measureRelation.idField,
      }],
      sort: [
        {field: 'count', direction},
        {field: dimension, direction: 'asc'},
      ],
      limit: extractAnalyticalLimit(text, target),
      offset: 0,
      confidence: 1,
      source: 'deterministic-analytical',
      sourceMessage: message,
      previousPlan: previousState?.plan || null,
    }
  }

  const dimension = findRelationDimension(measure, target)
  if (!dimension) return null

  const filters = buildDeterministicFilters(measure.id, text)
    .filter(filter => filter.field !== dimension)

  return {
    type: 'read-query-plan',
    operation: 'aggregate',
    entity: measure.id,
    filters,
    groupBy: [dimension],
    metrics: [{id: 'count', function: 'count', field: null}],
    sort: [
      {field: 'count', direction},
      {field: dimension, direction: 'asc'},
    ],
    limit: extractAnalyticalLimit(text, target),
    offset: 0,
    confidence: 1,
    source: 'deterministic-analytical',
    sourceMessage: message,
    previousPlan: previousState?.plan || null,
  }
}

function buildDeterministicAnalyticalPlan(message = '', previousState = null) {
  const text = normalizeText(message)
  if (!text || !isAnalyticalReadQueryRequest(text)) return null

  const relationalRankingPlan = buildRelationalRankingPlan(message, previousState)
  if (relationalRankingPlan) return relationalRankingPlan

  const explicitEntity = detectPrimaryEntity(text)
  const entityId = explicitEntity?.id || previousState?.entity || null
  if (!entityId) return null

  const entity = getReadEntityRegistry().get(entityId)
  const definition = getAnalyticalEntityDefinition(entityId)
  if (!entity || !definition) return null

  const groupByField = findGroupingField(definition, text)
  const asksGrouping = /\b(?:raggrupp\w*|divid\w*|suddivid\w*)\b/i.test(text)
  const asksCountByGroup =
    /\b(?:quanti|quante|conteggio|numero|conta)\b[\s\S]{0,100}\bper\b/i.test(text) ||
    /\bper\b[\s\S]{0,100}\b(?:quanti|quante|conteggio|numero|conta)\b/i.test(text)

  if (groupByField && (asksGrouping || asksCountByGroup)) {
    return {
      type: 'read-query-plan',
      operation: 'aggregate',
      entity: entity.id,
      filters: buildDeterministicFilters(entity.id, text),
      groupBy: [groupByField],
      metrics: [{id: 'count', function: 'count', field: null}],
      sort: [{field: 'count', direction: 'desc'}],
      limit: extractAnalyticalLimit(text, definition),
      offset: 0,
      confidence: 1,
      source: 'deterministic-analytical',
      sourceMessage: message,
      previousPlan: previousState?.plan || null,
    }
  }

  const rankDirection = /\b(?:piu|maggior\w*|massim\w*|top)\b/i.test(text)
    ? 'desc'
    : /\b(?:meno|minor\w*|minim\w*)\b/i.test(text)
      ? 'asc'
      : null
  const rankingField = rankDirection ? findRankingField(definition, text) : null

  if (rankingField) {
    return {
      type: 'read-query-plan',
      operation: 'list',
      entity: entity.id,
      filters: buildDeterministicFilters(entity.id, text),
      sort: [{field: rankingField, direction: rankDirection}],
      limit: extractAnalyticalLimit(text, definition),
      offset: 0,
      confidence: 1,
      source: 'deterministic-analytical',
      sourceMessage: message,
      previousPlan: previousState?.plan || null,
    }
  }

  return null
}

function containsSemanticAlias(text = '', alias = '') {
  const haystack = normalizeText(text)
  const needle = normalizeText(alias)
  if (!haystack || !needle) return false
  if (haystack === needle) return true
  return (` ${haystack} `).includes(` ${needle} `)
}

function getSemanticEntityDefinitions(message = '', previousState = null) {
  const definitions = getReadEntityDefinitions()
  const selected = []

  const add = definition => {
    if (!definition?.id || selected.some(item => item.id === definition.id)) return
    selected.push(definition)
  }

  for (const definition of definitions) {
    const aliases = [definition.id, definition.label, definition.singular, ...(definition.aliases || [])]
    if (aliases.some(alias => containsSemanticAlias(message, alias))) add(definition)
  }

  if (previousState?.entity) {
    add(definitions.find(definition => definition.id === previousState.entity))
  }

  return selected.length ? selected.slice(0, 6) : definitions
}

function normalizeSemanticOperation(value = '') {
  const operation = normalizeText(value).replace(/\s+/g, '-')
  const aliases = new Map([
    ['group', 'aggregate'],
    ['group-by', 'aggregate'],
    ['groupby', 'aggregate'],
    ['aggregation', 'aggregate'],
    ['aggregazione', 'aggregate'],
    ['rank', 'list'],
    ['ranking', 'list'],
  ])
  return aliases.get(operation) || operation
}

function normalizeSemanticMetricFunction(value = '') {
  const fn = normalizeText(value).replace(/[_\s]+/g, '-')
  const aliases = new Map([
    ['countdistinct', 'count-distinct'],
    ['distinct-count', 'count-distinct'],
    ['conteggio-distinti', 'count-distinct'],
    ['media', 'avg'],
    ['average', 'avg'],
    ['somma', 'sum'],
    ['minimum', 'min'],
    ['massimo', 'max'],
    ['maximum', 'max'],
  ])
  return aliases.get(fn) || fn
}

function normalizeSemanticEntity(value = '') {
  const raw = String(value || '').trim()
  if (!raw) return null
  const registry = getReadEntityRegistry()
  if (registry.has(raw)) return raw
  return findReadEntityByAlias(raw)?.id || raw
}

function normalizeSemanticField(entityId = '', value = '') {
  const raw = String(value || '').trim()
  if (!raw) return raw
  const entity = getReadEntityRegistry().get(entityId)
  if (!entity) return raw
  if (Object.prototype.hasOwnProperty.call(entity.fields || {}, raw)) return raw
  return findReadEntityFieldByAlias(entity, raw)?.id || raw
}

function normalizeSemanticMetricId(value = '', index = 0) {
  const raw = String(value || '').trim()
  if (/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(raw)) return raw
  return `metric${index + 1}`
}

function normalizeSemanticPlan(rawPlan = {}) {
  if (!rawPlan || typeof rawPlan !== 'object') return rawPlan

  const operation = normalizeSemanticOperation(rawPlan.operation)
  const entity = normalizeSemanticEntity(rawPlan.entity)
  if (!entity) return {...rawPlan, operation}

  const filters = (Array.isArray(rawPlan.filters) ? rawPlan.filters : []).map(filter => ({
    ...filter,
    field: normalizeSemanticField(entity, filter?.field),
  }))

  const groupBySource = Array.isArray(rawPlan.groupBy)
    ? rawPlan.groupBy
    : rawPlan.groupBy
      ? [rawPlan.groupBy]
      : []
  const groupBy = groupBySource.map(field => normalizeSemanticField(entity, field))

  const metrics = (Array.isArray(rawPlan.metrics) ? rawPlan.metrics : []).map((metric, index) => ({
    ...metric,
    id: normalizeSemanticMetricId(metric?.id, index),
    function: normalizeSemanticMetricFunction(metric?.function || metric?.fn),
    field:
      normalizeSemanticMetricFunction(metric?.function || metric?.fn) === 'count'
        ? null
        : normalizeSemanticField(entity, metric?.field),
  }))
  const metricIds = new Set(metrics.map(metric => metric.id))

  const sort = (Array.isArray(rawPlan.sort) ? rawPlan.sort : []).map(entry => {
    const rawField = String(entry?.field || '').trim()
    if (metricIds.has(rawField)) return {...entry, field: rawField}

    const normalizedSortTerm = normalizeText(rawField)
    const matchingMetric = metrics.filter(metric =>
      normalizeText(metric.function) === normalizedSortTerm ||
      (metric.function === 'count' && ['conteggio', 'numero', 'totale', 'count'].includes(normalizedSortTerm))
    )

    return {
      ...entry,
      field:
        matchingMetric.length === 1
          ? matchingMetric[0].id
          : normalizeSemanticField(entity, rawField),
    }
  })

  return {
    ...rawPlan,
    operation,
    entity,
    filters,
    groupBy,
    metrics,
    sort,
  }
}

function summarizePlannerRejection(stage, payload = {}) {
  console.warn('[renewals-read-query-planner]', JSON.stringify({stage, ...payload}))
}

function cleanTarget(value = '') {
  return String(value || '')
    .replace(/[?.!,;:]+$/g, '')
    .replace(/^['"“”]+|['"“”]+$/g, '')
    .replace(/^(?:il|lo|la|i|gli|le|un|una|dei|degli|delle)\s+/i, '')
    .trim()
}

function getHistoryContent(item = {}) {
  return String(item?.content || item?.message || item?.text || item?.reply || '').trim()
}

function getHistoryData(item = {}) {
  return item?.data || item?.payload || item?.response?.data || item?.result?.data || null
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function buildReadQueryStateFromData(data = {}) {
  const plan = data?.plan || null
  if (data?.type !== 'read-query-result' || !plan?.entity) return null

  const offset = toFiniteNumber(data.offset, toFiniteNumber(plan.offset, 0))
  const shown = toFiniteNumber(
    data.shown,
    Array.isArray(data.items) ? data.items.length : 0
  )
  const limit = toFiniteNumber(data.limit, toFiniteNumber(plan.limit, DEFAULT_READ_QUERY_LIMIT))

  return {
    plan,
    entity: data.entity || plan.entity,
    total: toFiniteNumber(data.total, 0),
    shown,
    offset,
    limit,
    hasMore: data.hasMore === true,
    nextOffset: toFiniteNumber(data.nextOffset, offset + shown),
    previousOffset: toFiniteNumber(data.previousOffset, Math.max(offset - limit, 0)),
    items: Array.isArray(data.items) ? data.items : [],
    dataSource: data.dataSource || null,
  }
}

function buildReadQueryStateFromPlan(plan = null, previousState = null) {
  if (!plan?.entity || (plan.entity === 'services' && plan.operation !== 'aggregate')) return null

  const sameEntity = previousState?.entity === plan.entity
  const offset = toFiniteNumber(plan.offset, 0)
  const limit = toFiniteNumber(plan.limit, DEFAULT_READ_QUERY_LIMIT)

  return {
    plan,
    entity: plan.entity,
    total: sameEntity ? toFiniteNumber(previousState.total, 0) : 0,
    shown: 0,
    offset,
    limit,
    hasMore: sameEntity ? previousState.hasMore === true : false,
    nextOffset: offset + limit,
    previousOffset: Math.max(offset - limit, 0),
    items: sameEntity && Array.isArray(previousState.items) ? previousState.items : [],
    dataSource: sameEntity ? previousState.dataSource || null : null,
  }
}

function buildTextHistoryItem(name = '', entityId = '') {
  const normalizedName = String(name || '').trim()
  if (!normalizedName) return null

  if (entityId === 'plan-prices') {
    return {
      name: normalizedName,
      plan: {name: normalizedName},
    }
  }

  return {name: normalizedName}
}

function parseAssistantReadQueryState(content = '', previousState = null) {
  if (!previousState?.plan || !content) return previousState

  const text = String(content || '').trim()
  if (!text) return previousState

  const totalMatch = text.match(/\bHo trovato\s+(\d+)\b/i)
  const rangeMatch = text.match(/\brisultati\s+(\d+)\s*-\s*(\d+)\b/i)
  const detailHeadingPattern = /^Dettagli\s+(?:per|del|della|dell['’]|dello|dei|degli|delle)\s+/i
  const isDetail = detailHeadingPattern.test(text)
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  const itemLines = lines.filter(line => /^[-•]\s+/.test(line))
  if (isDetail && !itemLines.length) {
    const detailLine = lines.find(
      line => !detailHeadingPattern.test(line) && line.includes('|')
    )
    if (detailLine) itemLines.push(detailLine)
  }

  const items = itemLines
    .map(line => line.replace(/^[-•]\s+/, '').split('|')[0].trim())
    .map(name => buildTextHistoryItem(name, previousState.entity))
    .filter(Boolean)

  const rangeStart = rangeMatch ? Number(rangeMatch[1]) : null
  const rangeEnd = rangeMatch ? Number(rangeMatch[2]) : null
  const offset = Number.isFinite(rangeStart)
    ? Math.max(rangeStart - 1, 0)
    : isDetail
      ? 0
      : previousState.offset
  const shown = Number.isFinite(rangeStart) && Number.isFinite(rangeEnd)
    ? Math.max(rangeEnd - rangeStart + 1, 0)
    : items.length || (isDetail ? 1 : previousState.shown)
  const total = totalMatch
    ? Number(totalMatch[1])
    : isDetail
      ? 1
      : previousState.total
  const dataSource = /nel catalogo completo/i.test(text)
    ? 'catalog'
    : /nei dati operativi dei servizi/i.test(text)
      ? 'operational-services'
      : previousState.dataSource

  return {
    ...previousState,
    total,
    shown,
    offset,
    hasMore: /Puoi chiedermi\s+["“”']altri/i.test(text),
    nextOffset: offset + shown,
    previousOffset: Math.max(offset - previousState.limit, 0),
    items: items.length ? items : previousState.items,
    dataSource,
  }
}

export function getPreviousReadQueryState(history = [], {fallbackState = null} = {}) {
  const items = Array.isArray(history) ? history : []
  let state = null
  let hasExplicitTopicAnchor = false

  for (const item of items) {
    const role = item?.role
    const content = getHistoryContent(item)

    if (role === 'user') {
      if (!content) continue

      const explicitEntity = detectPrimaryEntity(content)

      if (explicitEntity?.id === 'services' && !isAnalyticalReadQueryRequest(content)) {
        state = null
        hasExplicitTopicAnchor = true
        continue
      }

      const plan = buildDeterministicPlan(content, state)

      if (plan?.entity && plan.entity !== 'services') {
        state = buildReadQueryStateFromPlan(plan, state)
        hasExplicitTopicAnchor = true
      }

      continue
    }

    if (role !== 'assistant') continue

    const dataState = buildReadQueryStateFromData(getHistoryData(item))
    if (dataState) {
      state = dataState
      hasExplicitTopicAnchor = true
      continue
    }

    if (state && content) {
      state = parseAssistantReadQueryState(content, state)
    }
  }

  if (state) return state
  if (hasExplicitTopicAnchor) return null

  return fallbackState || null
}

function isAggregateRefinementRequest(message = '') {
  const text = normalizeText(message)
  if (!text) return false

  return /\b(?:ranking|classifica|graduatoria|confront\w*|esclud\w*|tranne|eccetto|tra\s+(?:i|le|gli)|fra\s+(?:i|le|gli))\b/i.test(text)
}

function getMostRecentAggregateReadQueryState(history = [], fallbackState = null) {
  const items = Array.isArray(history) ? history : []

  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.role !== 'assistant') continue
    const state = buildReadQueryStateFromData(getHistoryData(items[index]))
    if (state?.plan?.operation === 'aggregate') return state
  }

  return fallbackState?.plan?.operation === 'aggregate' ? fallbackState : null
}

function parsePagination(message = '', previousState = null) {
  if (!previousState) return null
  const text = normalizeText(message)

  const nextPageMatch = text.match(
    /^(?:e\s+)?(?:(?:mostra|mostrami|fammi\s+vedere)\s+)?(?:(?:gli|le|i)\s+)?(?:altri|altre|prossimi|prossime|successivi|successive|seguenti|ancora|continua|prosegui|vai avanti|avanti)(?:\s+(\d{1,2}|[a-z]+))?[?.!]*$/i
  )
  if (nextPageMatch) {
    const explicitLimit = parseLimitToken(nextPageMatch[1])
    const limit = explicitLimit || previousState.limit
    return {
      ...previousState.plan,
      limit,
      offset: previousState.nextOffset,
      source: 'follow-up-pagination',
      sourceMessage: message,
      previousPlan: previousState.plan,
    }
  }

  if (/^(?:torna\s+)?(?:indietro|precedenti|precedente|pagina precedente)[?.!]*$/i.test(text)) {
    return {
      ...previousState.plan,
      offset: previousState.previousOffset,
      source: 'follow-up-pagination',
      sourceMessage: message,
      previousPlan: previousState.plan,
    }
  }

  if (/^(?:torna\s+)?(?:all'inizio|ai primi|alle prime|prima pagina)[?.!]*$/i.test(text)) {
    return {
      ...previousState.plan,
      offset: 0,
      source: 'follow-up-pagination',
      sourceMessage: message,
      previousPlan: previousState.plan,
    }
  }

  return null
}

function detectPrimaryEntity(text = '') {
  const normalized = normalizeText(text)

  const rules = [
    ['macro-service-types', /\bmacro\s+(?:tipi|tipo|categorie|categoria)\s+di\s+servizio\b/i],
    ['service-types', /\b(?:tipi|tipo|categorie|categoria)\s+di\s+servizio\b/i],
    ['resources', /\b(?:tipi|tipo)\s+di\s+risors[ae]\b|\brisors[ae]\b/i],
    [
      'plan-prices',
      /\b(?:prezz[oi]|cost[oi]|tariff[ae])\b.{0,80}\b(?:pian[oi]|add[- ]?on|listino)\b|\b(?:pian[oi]|add[- ]?on)\b.{0,80}\b(?:prezz[oi]|cost[oi]|tariff[ae])\b|\bquanto\s+costa\b/i,
    ],
    ['addons', /\b(?:add[- ]?on|componenti aggiuntivi)\b/i],
    ['plans', /\b(?:piani|piano|plans?|offerte)\b/i],
    ['services', /\b(?:servizi|servizio)\b/i],
    ['subscriptions', /\b(?:sottoscrizioni|sottoscrizione|abbonamenti|abbonamento)\b/i],
    ['customers', /\b(?:clienti|cliente|aziende|azienda)\b/i],
    ['groups', /\b(?:gruppi aziendali|gruppo aziendale|gruppi|gruppo)\b/i],
    ['domains', /\b(?:domini|dominio)\b/i],
    ['communications', /\b(?:comunicazioni|comunicazione|mail inviate|email inviate)\b/i],
    ['price-lists', /\b(?:listini|listino|versioni listino|versione listino)\b/i],
    ['providers', /\b(?:fornitori|fornitore|providers?|suppliers?)\b/i],
  ]

  const candidates = rules
    .map(([id, pattern], priority) => {
      const match = pattern.exec(normalized)
      return match ? {id, index: match.index, priority} : null
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index || a.priority - b.priority)

  if (candidates[0]) {
    return getReadEntityRegistry().get(candidates[0].id) || null
  }

  return findReadEntityByAlias(normalized)
}

function detectOperation(text = '') {
  if (
    /\bquanto\s+costa\b|\bqual(?:e|i)\s+(?:e|è)\s+(?:il\s+)?prezzo\b|\bprezzo\s+(?:del|della|di)\s+piano\b/i.test(
      text
    )
  ) {
    return 'detail'
  }

  if (/\b(quanti|quante|numero|totale|conta|conteggio)\b/i.test(text)) return 'count'
  if (/\b(dettagli|dettaglio|scheda|informazioni|info|descrivi|descrizione)\b/i.test(text)) {
    return 'detail'
  }
  return 'list'
}

const ITALIAN_LIMITS = new Map([
  ['uno', 1], ['un', 1], ['una', 1], ['due', 2], ['tre', 3], ['quattro', 4],
  ['cinque', 5], ['sei', 6], ['sette', 7], ['otto', 8], ['nove', 9], ['dieci', 10],
  ['undici', 11], ['dodici', 12], ['tredici', 13], ['quattordici', 14],
  ['quindici', 15], ['sedici', 16], ['diciassette', 17], ['diciotto', 18],
  ['diciannove', 19], ['venti', 20],
])

function parseLimitToken(value = '') {
  const token = normalizeText(value)
  if (!token) return null
  const parsed = /^\d+$/.test(token) ? Number(token) : ITALIAN_LIMITS.get(token)
  if (!Number.isFinite(parsed)) return null
  return Math.min(Math.max(parsed, 1), 50)
}

function extractRequestedLimit(text = '') {
  const match = normalizeText(text).match(
    /\b(?:primi|prime|mostra|mostrami|elenca|elencami|dammi|top)\s+(\d{1,2}|[a-z]+)\b/i
  )
  if (!match?.[1]) return null

  return parseLimitToken(match[1])
}

function extractLimit(text = '') {
  return extractRequestedLimit(text) || DEFAULT_READ_QUERY_LIMIT
}

function yearRange(year) {
  return {
    start: `${year}-01-01T00:00:00.000Z`,
    end: `${year}-12-31T23:59:59.999Z`,
  }
}

function extractYear(text = '') {
  const year = Number(text.match(/\b(20\d{2})\b/)?.[1])
  return Number.isFinite(year) ? year : null
}

const ITALIAN_MONTHS = new Map([
  ['gennaio', 0], ['gen', 0],
  ['febbraio', 1], ['feb', 1],
  ['marzo', 2], ['mar', 2],
  ['aprile', 3], ['apr', 3],
  ['maggio', 4], ['mag', 4],
  ['giugno', 5], ['giu', 5],
  ['luglio', 6], ['lug', 6],
  ['agosto', 7], ['ago', 7],
  ['settembre', 8], ['set', 8],
  ['ottobre', 9], ['ott', 9],
  ['novembre', 10], ['nov', 10],
  ['dicembre', 11], ['dic', 11],
])

function extractMonthRange(text = '', year = null) {
  if (!year) return null

  const monthToken = String(text).match(
    /\b(gen(?:naio)?|feb(?:braio)?|mar(?:zo)?|apr(?:ile)?|mag(?:gio)?|giu(?:gno)?|lug(?:lio)?|ago(?:sto)?|set(?:tembre)?|ott(?:obre)?|nov(?:embre)?|dic(?:embre)?)\b/i
  )?.[1]
  const month = ITALIAN_MONTHS.get(String(monthToken || '').toLowerCase())
  if (month === undefined) return null

  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)).toISOString(),
    end: new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)).toISOString(),
  }
}

function extractNamedAfter(text = '', patterns = []) {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    const target = cleanTarget(match?.[1])
    if (target) return target
  }
  return null
}

function buildDeterministicFilters(entityId, message = '') {
  const text = normalizeText(message)
  const filters = []
  const year = extractYear(text)
  const monthRange = extractMonthRange(text, year)

  if (entityId === 'providers') {
    if (/\b(presenti|utilizzati|usati|con servizi|con sottoscrizioni)\b/i.test(text)) {
      filters.push({field: 'present', operator: 'truthy', value: null})
    }
    if (year) filters.push({field: 'expiryYears', operator: 'contains', value: year})
  }

  if (entityId === 'plans' || entityId === 'addons') {
    const supplier = extractNamedAfter(text, [
      /\b(?:del|della|di|con)\s+(?:fornitore\s+)?(.+?)(?=\s+(?:che|con|senza|nel|nell'anno|in scadenza|usati|utilizzati)\b|$)/i,
      /\bfornitore\s+(.+)$/i,
    ])
    if (supplier && !/^(?:tutti|tutte|i piani|piani|add-on|addon)$/i.test(supplier)) {
      filters.push({field: 'supplier.name', operator: 'contains', value: supplier})
    }

    const customer = extractNamedAfter(text, [
      /\b(?:usati|utilizzati|assegnati)\s+(?:da|dal|dalla)\s+(.+)$/i,
      /\b(?:del|della)\s+cliente\s+(.+)$/i,
    ])
    if (customer) filters.push({field: 'customerNames', operator: 'contains', value: customer})

    const resource = extractNamedAfter(text, [
      /\bcon\s+(?:la\s+)?risorsa\s+(.+)$/i,
      /\bche\s+(?:includono|contengono|prevedono)\s+(.+)$/i,
    ])
    if (resource) filters.push({field: 'resourceNames', operator: 'contains', value: resource})

    if (year) filters.push({field: 'expiryYears', operator: 'contains', value: year})
    if (/\bsenza prezzo\b|\bprezzo mancante\b/i.test(text)) {
      filters.push({field: 'missingPrice', operator: 'truthy', value: null})
    }
  }

  if (entityId === 'plan-prices') {
    const plan = extractNamedAfter(text, [
      /\b(?:prezz[oi]|costo|tariffa)\s+(?:del|della|di)\s+(?:piano|add[- ]?on)\s+(.+?)(?=\s+(?:nel|del|per|con)\s+listino\b|\s+del\s+fornitore\b|$)/i,
      /\bquanto\s+costa\s+(?:il|lo|la)?\s*(?:piano|add[- ]?on)\s+(.+?)(?=\s+(?:nel|del|per|con)\s+listino\b|$)/i,
      /\bquanto\s+costa\s+(.+?)(?=\s+(?:nel|del|per|con)\s+listino\b|$)/i,
      /\b(?:piano|add[- ]?on)\s+(.+?)(?=\s+(?:nel|del|per|con)\s+listino\b|\s+(?:ha|con)\s+prezzo\b|$)/i,
    ])
    if (
      plan &&
      !/^(?:piani|piano|add-on|addon|tutti|tutte)$/i.test(plan) &&
      !/^(?:nel|del|della|per|con)\s+listino\b/i.test(plan)
    ) {
      filters.push({field: 'plan.name', operator: 'contains', value: plan})
    }

    const priceList = extractNamedAfter(text, [
      /\b(?:nel|del|della|per il|per la|di)\s+listino\s+(.+)$/i,
      /\blistino\s+(.+)$/i,
    ])
    if (priceList && !/^(?:listino|listini|tutti|tutte)$/i.test(priceList)) {
      if (/^20\d{2}$/.test(priceList)) {
        filters.push({
          field: 'priceListVersion.version',
          operator: 'equals',
          value: Number(priceList),
        })
      } else {
        filters.push({
          field: 'priceListVersion.name',
          operator: 'contains',
          value: priceList,
        })
      }
    } else if (year && /\blistino\b/i.test(text)) {
      filters.push({
        field: 'priceListVersion.version',
        operator: 'equals',
        value: year,
      })
    }

    const supplier = extractNamedAfter(text, [
      /\b(?:del|della|di|con)\s+fornitore\s+(.+)$/i,
    ])
    if (supplier) {
      filters.push({field: 'supplier.name', operator: 'contains', value: supplier})
    }

    if (/\badd[- ]?on\b|\bcomponenti aggiuntivi\b/i.test(text)) {
      filters.push({field: 'plan.kind', operator: 'equals', value: 'addon'})
    } else if (/\bpiani base\b|\bpiano base\b/i.test(text)) {
      filters.push({field: 'plan.kind', operator: 'equals', value: 'base'})
    }
  }

  if (entityId === 'resources') {
    const plan = extractNamedAfter(text, [
      /\b(?:del|della|di|nel|nel piano)\s+(?:piano\s+)?(.+)$/i,
      /\bpiano\s+(.+)$/i,
    ])
    if (plan && !/^(?:risorsa|risorse|tipo di risorsa|tipi di risorsa)$/i.test(plan)) {
      filters.push({field: 'planNames', operator: 'contains', value: plan})
    }

    const supplier = extractNamedAfter(text, [/\b(?:del|di)\s+fornitore\s+(.+)$/i])
    if (supplier) filters.push({field: 'supplierNames', operator: 'contains', value: supplier})
  }

  if (entityId === 'customers') {
    const group = extractNamedAfter(text, [
      /\b(?:del|della|di|nel)\s+gruppo\s+(.+)$/i,
      /\bgruppo\s+(.+)$/i,
    ])
    if (group) filters.push({field: 'group.name', operator: 'contains', value: group})

    const provider = extractNamedAfter(text, [/\b(?:con|del)\s+fornitore\s+(.+)$/i])
    if (provider) filters.push({field: 'providerNames', operator: 'contains', value: provider})
    if (monthRange) {
      filters.push({field: 'expiryDates', operator: 'between', value: monthRange})
    } else if (year) {
      filters.push({field: 'expiryYears', operator: 'contains', value: year})
    }
  }

  if (entityId === 'groups') {
    const provider = extractNamedAfter(text, [/\b(?:con|del)\s+fornitore\s+(.+)$/i])
    if (provider) filters.push({field: 'providerNames', operator: 'contains', value: provider})
    if (year) filters.push({field: 'expiryYears', operator: 'contains', value: year})
  }

  if (entityId === 'subscriptions') {
    if (/\b(?:fornitore|supplier|provider)\b/i.test(text)) {
      filters.push({field: 'kind', operator: 'equals', value: 'supplier'})
    } else if (/\bcliente\b/i.test(text)) {
      filters.push({field: 'kind', operator: 'equals', value: 'customer'})
    }

    const supplier = extractNamedAfter(text, [
      /\b(?:con|del|della|di)\s+(?:fornitore\s+)?(.+?)(?=\s+(?:che|nel|in scadenza|scadono)\b|$)/i,
      /\bfornitore\s+(.+)$/i,
    ])
    if (supplier && !/^(?:cliente|fornitore|supplier|provider)$/i.test(supplier)) {
      filters.push({field: 'supplier.name', operator: 'contains', value: supplier})
    }

    const plan = extractNamedAfter(text, [/\b(?:con|del)\s+piano\s+(.+)$/i])
    if (plan) filters.push({field: 'plan.name', operator: 'contains', value: plan})

    if (year) {
      filters.push({field: 'endsOn', operator: 'between', value: yearRange(year)})
    }
  }

  if (entityId === 'service-types') {
    const macro = extractNamedAfter(text, [
      /\b(?:della|del|di|nella)\s+macro(?:categoria| tipo)?\s+(.+)$/i,
      /\bmacro\s+(.+)$/i,
    ])
    if (macro) filters.push({field: 'macro.name', operator: 'contains', value: macro})
  }

  if (entityId === 'domains') {
    if (/\bnon\s+(?:sono\s+)?collegat[oi]\s+(?:a\s+)?plesk\b|\bsenza plesk\b/i.test(text)) {
      filters.push({field: 'hasPlesk', operator: 'falsey', value: null})
    } else if (/\bcollegat[oi]\s+(?:a\s+)?plesk\b|\bcon plesk\b/i.test(text)) {
      filters.push({field: 'hasPlesk', operator: 'truthy', value: null})
    }
  }

  if (entityId === 'communications') {
    const service = extractNamedAfter(text, [/\b(?:di|del|per)\s+(?:il\s+)?(?:servizio\s+)?(.+)$/i])
    if (service) filters.push({field: 'service.name', operator: 'contains', value: service})
    if (year) filters.push({field: 'year', operator: 'equals', value: year})
  }

  if (entityId === 'services') {
    const provider = extractNamedAfter(text, [/\b(?:del|di|con)\s+fornitore\s+(.+)$/i])
    if (provider) filters.push({field: 'providerNames', operator: 'contains', value: provider})
    const plan = extractNamedAfter(text, [/\b(?:con|del)\s+piano\s+(.+)$/i])
    if (plan) filters.push({field: 'planNames', operator: 'contains', value: plan})
    if (year) filters.push({field: 'expiryYears', operator: 'contains', value: year})
  }

  return filters
}

function buildDeterministicFollowUpPlan(message = '', previousState = null) {
  const previousPlan = previousState?.plan
  const text = normalizeText(message)
  if (!previousPlan?.entity || !text) return null
  const aggregateRefinement = previousPlan.operation === 'aggregate' && isAggregateRefinementRequest(text)
  if (!aggregateRefinement && !/^\s*(?:e|ed|ma|invece|ora|adesso|poi|tra\s+quest[ei]|fra\s+quest[ei]|di\s+quest[ei]|quest[ei]|quell[ei])\b/i.test(text)) {
    return null
  }

  const year = extractYear(text)
  const requestedLimit = extractRequestedLimit(text)
  const exclusionMatch = text.match(
    /\b(?:esclud\w*|tranne|eccetto)\s+(.+?)(?=\s+(?:e|ed)\s+(?:confront\w*|mostra\w*|ordina\w*|limita\w*)\b|[,;.!?]|$)/i
  )
  const exclusion = cleanTarget(exclusionMatch?.[1] || '')
  if (!year && !requestedLimit && !exclusion) return null

  const definition = getAnalyticalEntityDefinition(previousPlan.entity)
  const timeField = definition?.analytics?.timeField || null
  const filters = Array.isArray(previousPlan.filters) ? [...previousPlan.filters] : []

  if (year) {
    const fallbackTimeField = filters.find(filter =>
      filter?.operator === 'between' &&
      /^20\d{2}-/.test(String(filter?.value?.start || '')) &&
      /^20\d{2}-/.test(String(filter?.value?.end || ''))
    )?.field
    const resolvedTimeField = timeField || fallbackTimeField
    if (!resolvedTimeField) return null

    const retainedFilters = filters.filter(filter => filter.field !== resolvedTimeField)
    retainedFilters.push({
      field: resolvedTimeField,
      operator: 'between',
      value: yearRange(year),
    })
    filters.splice(0, filters.length, ...retainedFilters)
  }

  if (exclusion) {
    const groupField = Array.isArray(previousPlan.groupBy) ? previousPlan.groupBy[0] : null
    if (!groupField) return null
    const retainedFilters = filters.filter(filter =>
      !(filter.field === groupField && filter.operator === 'not-equals')
    )
    retainedFilters.push({field: groupField, operator: 'not-equals', value: exclusion})
    filters.splice(0, filters.length, ...retainedFilters)
  }

  return {
    ...previousPlan,
    filters,
    limit: requestedLimit || previousPlan.limit || DEFAULT_READ_QUERY_LIMIT,
    offset: 0,
    confidence: 1,
    source: 'deterministic-follow-up',
    sourceMessage: message,
    previousPlan,
  }
}

function buildDeterministicPlan(
  message = '',
  previousState = null,
  resolvedDetailTarget = null,
  readUtterance = null
) {
  const text = normalizeText(message)
  if (!text) return null

  const pagination = parsePagination(message, previousState)
  if (pagination) return pagination

  const followUp = buildDeterministicFollowUpPlan(message, previousState)
  if (followUp) return followUp

  const analyticalPlan = buildDeterministicAnalyticalPlan(message, previousState)
  if (analyticalPlan) return analyticalPlan

  if (resolvedDetailTarget?.entityId) {
    if (resolvedDetailTarget.entityId === 'services') return null

    const resolvedEntity = getReadEntityRegistry().get(resolvedDetailTarget.entityId)
    if (!resolvedEntity || !resolvedDetailTarget.filter) return null

    return {
      type: 'read-query-plan',
      operation: 'detail',
      entity: resolvedEntity.id,
      filters: [resolvedDetailTarget.filter],
      sort: resolvedEntity.defaultSort || [{field: 'name', direction: 'asc'}],
      limit: 10,
      offset: 0,
      confidence: 1,
      source: 'deterministic-target-resolution',
      sourceMessage: message,
      previousPlan: previousState?.plan || null,
    }
  }

  const utteranceEntity = readUtterance?.entityHint
    ? getReadEntityRegistry().get(readUtterance.entityHint) || null
    : null
  const entity = utteranceEntity || detectPrimaryEntity(text)
  const previousEntity = previousState?.entity
    ? getReadEntityRegistry().get(previousState.entity) || null
    : null
  const detailReference = buildReadQueryDetailReference({
    message,
    explicitEntity: entity,
    readUtterance,
    previousState: previousState
      ? {
          ...previousState,
          entityDefinition: previousEntity,
        }
      : null,
  })

  if (detailReference) {
    const detailEntity = getReadEntityRegistry().get(detailReference.entityId)
    if (!detailEntity) return null

    return {
      type: 'read-query-plan',
      operation: 'detail',
      entity: detailEntity.id,
      filters: [detailReference.filter],
      sort: detailEntity.defaultSort || [{field: 'name', direction: 'asc'}],
      limit: detailReference.limit,
      offset: 0,
      confidence: 0.99,
      source: 'deterministic-reference',
      sourceMessage: message,
      previousPlan: previousState?.plan || null,
    }
  }

  if (!entity) return null

  // Le liste di servizi restano inizialmente affidate al planner storico già coperto dai test.
  if (entity.id === 'services') return null

  const operation = detectOperation(text)
  const filters = buildDeterministicFilters(entity.id, text)

  return {
    type: 'read-query-plan',
    operation,
    entity: entity.id,
    filters,
    sort: entity.defaultSort || [{field: 'name', direction: 'asc'}],
    limit: operation === 'count' ? 0 : extractLimit(text),
    offset: 0,
    confidence: 0.98,
    source: 'deterministic',
    sourceMessage: message,
  }
}

function extractJsonObject(value = '') {
  const text = String(value || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  try {
    return JSON.parse(text)
  } catch {}

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

function shouldUseSemanticPlanner(message = '', previousState = null, readUtterance = null) {
  const text = normalizeText(message)
  if (!text) return false
  if (readUtterance?.operation === 'detail') return false
  if (isAnalyticalReadQueryRequest(text)) return true

  if (previousState && /^(?:e|ora|adesso|solo|soltanto|quelli|quelle|questi|queste|tra questi|fra questi)\b/i.test(text)) {
    return true
  }

  return Boolean(detectPrimaryEntity(text))
}

async function buildSemanticPlan({message, previousState, callLlm}) {
  const definitions = getSemanticEntityDefinitions(message, previousState)
  const registrySummary = definitions.map(definition => ({
    id: definition.id,
    label: definition.label,
    singular: definition.singular,
    aliases: definition.aliases,
    fields: Object.entries(definition.fields || {}).map(([id, config]) => ({
      id,
      type: config?.type || 'string',
      label: config?.label || id,
      aliases: Array.isArray(config?.aliases) ? config.aliases : [],
    })),
  }))

  const systemPrompt = [
    'Sei il planner strutturato di sola lettura del modulo rinnovi Webcloud.',
    'Non rispondere all’utente e non accedere a database o API.',
    'Trasforma la richiesta in un piano JSON usando esclusivamente entità, campi e operatori consentiti.',
    'Puoi usare sia gli id canonici sia label/alias semantici dei campi: il backend li normalizzerà e poi validerà il piano.',
    'Le action, le conferme, gli annullamenti e le diagnostiche sono gestiti prima di questo planner.',
    'Non inventare nomi, filtri o valori non presenti nella richiesta.',
    'Se la richiesta è un seguito, modifica il previousPlan senza perdere filtri, raggruppamenti o metriche ancora pertinenti.',
    'Nelle richieste analitiche, espressioni come "per <dimensione>", "per ogni <dimensione>" o "per ciascuna <dimensione>" indicano normalmente una dimensione di groupBy, non il valore di un filtro.',
    'Non usare mai articoli, preposizioni o congiunzioni isolate come e, ed, di, del, con o per come valori di filtro.',
    'Se l’utente chiede quanti record esistono per ciascun valore di una dimensione, usa aggregate con groupBy su quella dimensione e una metrica count.',
    'Usa operation=aggregate soltanto quando servono raggruppamenti o metriche calcolate; se una metrica è già un campo numerico dell’entità preferisci list + sort.',
    'Le entità possono già contenere metriche derivate. Per esempio, se una entità espone un campo come numero servizi o numero piani, usalo direttamente invece di ricontare i record dell’entità.',
    'Non aggregare una entità per il suo stesso nome per contare gli elementi collegati: usa una metrica derivata disponibile oppure aggrega l’entità che rappresenta davvero gli elementi da contare.',
    'Per aggregate puoi usare groupBy con al massimo 2 campi e metrics con al massimo 4 metriche.',
    'Funzioni metriche consentite: count, count-distinct, sum, avg, min, max.',
    'count non richiede field; count-distinct richiede un field; sum e avg richiedono campi number/number-array; min e max richiedono campi number/number-array/date.',
    'Nelle query aggregate sort può riferirsi soltanto a un campo di groupBy oppure all’id di una metrica.',
    'Non creare join, subquery o piani multi-step: se la richiesta li richiede, produci soltanto ciò che è rappresentabile dal contratto.',
    'Per entity=services usa il nuovo planner soltanto con operation=aggregate; list, count e detail restano affidati al planner storico.',
    'Operatori consentiti: equals, not-equals, contains, not-contains, in, between, gte, lte, exists, not-exists, truthy, falsey.',
    'Restituisci esclusivamente JSON valido senza markdown.',
  ].join(' ')

  const payload = {
    request: String(message || '').trim(),
    previousPlan: previousState?.plan || null,
    entities: registrySummary,
    outputInstructions: [
      'Compila tutti i campi richiesti dallo schema strutturato.',
      'Usa array vuoti per filters, groupBy, metrics e sort quando non servono.',
      'Per operation=unknown usa entity=null e gli array vuoti.',
    ],
    outputSchema: READ_QUERY_PLAN_OUTPUT_SCHEMA,
  }

  const raw = await callLlm({
    timeoutMs: env.ollamaReadPlannerTimeoutMs,
    format: READ_QUERY_PLAN_OUTPUT_SCHEMA,
    options: {temperature: 0, num_predict: 500},
    messages: [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: JSON.stringify(payload)},
    ],
  })

  const parsed = raw && typeof raw === 'object' ? raw : extractJsonObject(raw)
  if (!parsed) {
    const rawText = String(raw || '').trim()
    summarizePlannerRejection('invalid-json', {
      rawLength: rawText.length,
      startsWithBrace: rawText.startsWith('{'),
      endsWithBrace: rawText.endsWith('}'),
      firstChar: rawText.slice(0, 1) || null,
      lastChar: rawText.slice(-1) || null,
    })
    return null
  }

  const operation = normalizeSemanticOperation(parsed.operation)
  if (!operation || operation === 'unknown') {
    summarizePlannerRejection('model-unknown', {
      operation: operation || null,
      entity: parsed?.entity || null,
      confidence: Number.isFinite(Number(parsed?.confidence)) ? Number(parsed.confidence) : null,
    })
    return null
  }

  const explicitConfidence = Number(parsed.confidence)
  if (Number.isFinite(explicitConfidence) && explicitConfidence < 0.45) {
    summarizePlannerRejection('low-model-confidence', {
      confidence: explicitConfidence,
      operation,
      entity: parsed.entity || null,
    })
    return null
  }

  return {
    ...normalizeSemanticPlan(parsed),
    source: 'semantic',
    sourceMessage: message,
    previousPlan: previousState?.plan || null,
  }
}

export async function planReadQuery({
  message = '',
  history = [],
  callLlm = callOllamaChat,
  allowSemantic = true,
  actorToken = '',
  resolvedDetailTarget = null,
  readUtterance = null,
  onSemanticError = null,
} = {}) {
  const effectiveHistory = Array.isArray(history) ? [...history] : []
  const lastHistoryItem = effectiveHistory.at(-1)
  if (
    lastHistoryItem?.role === 'user' &&
    normalizeText(getHistoryContent(lastHistoryItem)) === normalizeText(message)
  ) {
    effectiveHistory.pop()
  }
  const rememberedState = getRememberedReadQueryContext({actorToken})
  const previousState = getPreviousReadQueryState(effectiveHistory, {
    fallbackState: rememberedState,
  })
  const aggregateState = isAggregateRefinementRequest(message)
    ? getMostRecentAggregateReadQueryState(effectiveHistory, rememberedState)
    : null
  const deterministicState = previousState?.plan?.operation === 'aggregate'
    ? previousState
    : aggregateState || previousState
  const registry = getReadEntityRegistry()
  const deterministic = buildDeterministicPlan(
    message,
    deterministicState,
    resolvedDetailTarget,
    readUtterance
  )

  const analyticalRequest = isAnalyticalReadQueryRequest(message)

  if (
    deterministic &&
    (!analyticalRequest ||
      deterministic.source === 'follow-up-pagination' ||
      deterministic.source === 'deterministic-follow-up' ||
      deterministic.source === 'deterministic-analytical')
  ) {
    const validation = validateReadQueryPlan(deterministic, registry)
    if (validation.ok) return validation.plan

    if (deterministic.source === 'deterministic-analytical') {
      summarizePlannerRejection('deterministic-analytical-validation', {
        reason: validation.reason || null,
        operation: deterministic.operation || null,
        entity: deterministic.entity || null,
      })
    }
  }

  if (!allowSemantic || !shouldUseSemanticPlanner(message, previousState, readUtterance)) {
    return null
  }

  try {
    const semantic = await buildSemanticPlan({message, previousState, callLlm})
    if (!semantic) return null

    const merged = previousState?.plan
      ? mergeReadQueryPlans(previousState.plan, semantic)
      : semantic
    const validation = validateReadQueryPlan(merged, registry)

    if (!validation.ok) {
      summarizePlannerRejection('validation', {
        reason: validation.reason || null,
        operation: merged?.operation || null,
        entity: merged?.entity || null,
        groupBy: Array.isArray(merged?.groupBy) ? merged.groupBy : [],
        metrics: Array.isArray(merged?.metrics)
          ? merged.metrics.map(metric => ({id: metric?.id || null, function: metric?.function || null, field: metric?.field || null}))
          : [],
        sort: Array.isArray(merged?.sort) ? merged.sort : [],
      })
      return null
    }
    if (validation.plan.entity === 'services' && validation.plan.operation !== 'aggregate') {
      summarizePlannerRejection('services-non-aggregate', {
        operation: validation.plan.operation,
      })
      return null
    }

    return validation.plan
  } catch (error) {
    summarizePlannerRejection('exception', {
      errorName: error?.name || 'Error',
      message: String(error?.message || '').slice(0, 240),
    })

    if (typeof onSemanticError === 'function') {
      onSemanticError(error)
    }

    return null
  }
}
