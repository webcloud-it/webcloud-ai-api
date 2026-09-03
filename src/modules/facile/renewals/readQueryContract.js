const ALLOWED_OPERATIONS = new Set(['list', 'count', 'detail', 'aggregate'])
const ALLOWED_OPERATORS = new Set([
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
])
const ALLOWED_DIRECTIONS = new Set(['asc', 'desc'])
const ALLOWED_AGGREGATE_FUNCTIONS = new Set([
  'count',
  'count-distinct',
  'sum',
  'avg',
  'min',
  'max',
])

export const DEFAULT_READ_QUERY_LIMIT = 20
export const MAX_READ_QUERY_LIMIT = 50
export const MAX_READ_QUERY_GROUP_BY_FIELDS = 2
export const MAX_READ_QUERY_METRICS = 4
export const MAX_READ_QUERY_HAVING_FILTERS = 4

function clampInteger(value, fallback, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) {
  const number = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(number, min), max)
}

function normalizeScalar(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return value
}

function normalizeFilter(filter = {}, allowedFields = new Set()) {
  const field = String(filter?.field || '').trim()
  const operator = String(filter?.operator || '').trim()

  if (!field || !allowedFields.has(field) || !ALLOWED_OPERATORS.has(operator)) {
    return null
  }

  if (operator === 'between') {
    const source = filter?.value
    const start = source?.start ?? source?.from ?? null
    const end = source?.end ?? source?.to ?? null

    if (start == null || end == null) return null

    return {
      field,
      operator,
      value: {
        start: normalizeScalar(start),
        end: normalizeScalar(end),
      },
    }
  }

  if (operator === 'in') {
    const values = Array.isArray(filter?.value) ? filter.value : [filter?.value]
    const normalized = values.map(normalizeScalar).filter(value => value !== null && value !== '')
    if (!normalized.length) return null

    return {
      field,
      operator,
      value: normalized,
    }
  }

  if (['exists', 'not-exists', 'truthy', 'falsey'].includes(operator)) {
    return {field, operator, value: null}
  }

  const value = normalizeScalar(filter?.value)
  if (value === null || value === '') return null

  return {field, operator, value}
}

function normalizeSort(sort = [], allowedFields = new Set()) {
  const source = Array.isArray(sort) ? sort : []
  const out = []

  for (const entry of source) {
    const field = String(entry?.field || '').trim()
    const direction = String(entry?.direction || 'asc').trim().toLowerCase()

    if (!field || !allowedFields.has(field) || !ALLOWED_DIRECTIONS.has(direction)) {
      continue
    }

    if (!out.some(item => item.field === field)) {
      out.push({field, direction})
    }
  }

  return out.slice(0, 3)
}

function normalizeGroupBy(groupBy = [], allowedFields = new Set()) {
  const values = Array.isArray(groupBy) ? groupBy : [groupBy]
  const out = []

  for (const value of values) {
    const field = String(value || '').trim()
    if (!field || !allowedFields.has(field) || out.includes(field)) continue
    out.push(field)
  }

  return out.slice(0, MAX_READ_QUERY_GROUP_BY_FIELDS)
}

function isNumberType(type = '') {
  return type === 'number' || type === 'number-array'
}

function isOrderableAggregateType(type = '') {
  return isNumberType(type) || type === 'date'
}

function normalizeMetricId(value = '', index = 0) {
  const id = String(value || '').trim()
  if (/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(id)) return id
  return `metric${index + 1}`
}

function normalizeMetrics(metrics = [], fields = {}) {
  const source = Array.isArray(metrics) ? metrics : []
  const out = []
  const usedIds = new Set()

  for (const [index, entry] of source.entries()) {
    const fn = String(entry?.function || entry?.fn || '').trim().toLowerCase()
    if (!ALLOWED_AGGREGATE_FUNCTIONS.has(fn)) continue

    const field = entry?.field == null ? null : String(entry.field).trim()
    const fieldDefinition = field ? fields?.[field] : null

    if (fn !== 'count' && (!field || !fieldDefinition)) continue
    if (['sum', 'avg'].includes(fn) && !isNumberType(fieldDefinition?.type)) continue
    if (['min', 'max'].includes(fn) && !isOrderableAggregateType(fieldDefinition?.type)) continue

    let id = normalizeMetricId(entry?.id, index)
    if (usedIds.has(id)) continue
    usedIds.add(id)

    out.push({
      id,
      function: fn,
      field: fn === 'count' ? null : field,
    })
  }

  return out.slice(0, MAX_READ_QUERY_METRICS)
}

function defaultAggregateSort(groupBy = [], metrics = []) {
  if (metrics.length) return [{field: metrics[0].id, direction: 'desc'}]
  if (groupBy.length) return [{field: groupBy[0], direction: 'asc'}]
  return []
}

export function validateReadQueryPlan(plan = {}, registry) {
  const entityId = String(plan?.entity || '').trim()
  const entity = registry?.get(entityId)

  if (!entity) {
    return {
      ok: false,
      reason: 'unknown-entity',
      message: `Entità non supportata: ${entityId || 'non specificata'}`,
    }
  }

  const requestedOperation = String(plan?.operation || '').trim()
  if (requestedOperation && !ALLOWED_OPERATIONS.has(requestedOperation)) {
    return {
      ok: false,
      reason: 'unsupported-operation',
      message: `Operazione non supportata: ${requestedOperation}`,
    }
  }

  const operation = requestedOperation || 'list'
  const fields = entity.fields || {}
  const allowedFields = new Set(Object.keys(fields))
  const rawFilters = Array.isArray(plan?.filters) ? plan.filters : []
  const filters = rawFilters
    .map(filter => normalizeFilter(filter, allowedFields))
    .filter(Boolean)

  if (filters.length !== rawFilters.length) {
    return {
      ok: false,
      reason: 'invalid-filter',
      message: 'La query contiene almeno un filtro, campo o operatore non autorizzato.',
    }
  }

  const rawGroupBy = operation === 'aggregate'
    ? (Array.isArray(plan?.groupBy) ? plan.groupBy : plan?.groupBy ? [plan.groupBy] : [])
    : []
  const groupBy = operation === 'aggregate'
    ? normalizeGroupBy(rawGroupBy, allowedFields)
    : []

  if (operation === 'aggregate' && (rawGroupBy.length > MAX_READ_QUERY_GROUP_BY_FIELDS || groupBy.length !== rawGroupBy.length)) {
    return {
      ok: false,
      reason: 'invalid-group-by',
      message: 'La query contiene un raggruppamento non autorizzato o troppo ampio.',
    }
  }

  const rawMetrics = operation === 'aggregate' && Array.isArray(plan?.metrics) ? plan.metrics : []
  const metrics = operation === 'aggregate'
    ? normalizeMetrics(rawMetrics, fields)
    : []

  if (operation === 'aggregate' && rawMetrics.length > MAX_READ_QUERY_METRICS) {
    return {
      ok: false,
      reason: 'too-many-aggregate-metrics',
      message: `Sono consentite al massimo ${MAX_READ_QUERY_METRICS} metriche per query.`,
    }
  }

  if (operation === 'aggregate' && metrics.length !== rawMetrics.length) {
    return {
      ok: false,
      reason: 'invalid-aggregate-metric',
      message: 'La query contiene almeno una metrica o un campo aggregato non autorizzato.',
    }
  }

  if (operation === 'aggregate' && metrics.some(metric => allowedFields.has(metric.id))) {
    return {
      ok: false,
      reason: 'aggregate-metric-id-conflict',
      message: 'L’id di una metrica aggregata non può coincidere con un campo dell’entità.',
    }
  }

  if (operation === 'aggregate' && !metrics.length) {
    return {
      ok: false,
      reason: 'aggregate-metrics-required',
      message: 'Una query aggregata richiede almeno una metrica valida.',
    }
  }

  const metricFields = new Set(metrics.map(metric => metric.id))
  const rawHaving = operation === 'aggregate' && Array.isArray(plan?.having) ? plan.having : []
  const having = rawHaving
    .map(filter => normalizeFilter(filter, metricFields))
    .filter(Boolean)

  if (operation === 'aggregate' && rawHaving.length > MAX_READ_QUERY_HAVING_FILTERS) {
    return {
      ok: false,
      reason: 'too-many-having-filters',
      message: `Sono consentiti al massimo ${MAX_READ_QUERY_HAVING_FILTERS} filtri sui risultati aggregati.`,
    }
  }

  if (operation === 'aggregate' && having.length !== rawHaving.length) {
    return {
      ok: false,
      reason: 'invalid-having-filter',
      message: 'La query contiene almeno un filtro aggregato non autorizzato.',
    }
  }

  const aggregateSortFields = new Set([
    ...groupBy,
    ...metrics.map(metric => metric.id),
  ])
  const rawSort = Array.isArray(plan?.sort) ? plan.sort : []
  const sort = normalizeSort(
    rawSort,
    operation === 'aggregate' ? aggregateSortFields : allowedFields
  )

  if (sort.length !== rawSort.length) {
    return {
      ok: false,
      reason: 'invalid-sort',
      message: 'La query contiene almeno un ordinamento su un campo non autorizzato.',
    }
  }
  const limit = clampInteger(
    operation === 'count' ? 0 : plan?.limit,
    operation === 'detail' ? 10 : DEFAULT_READ_QUERY_LIMIT,
    {min: operation === 'count' ? 0 : 1, max: MAX_READ_QUERY_LIMIT}
  )
  const offset = clampInteger(plan?.offset, 0, {min: 0})
  const confidence = Number.isFinite(Number(plan?.confidence))
    ? Math.max(0, Math.min(1, Number(plan.confidence)))
    : 1

  const normalizedSort = sort.length
    ? sort
    : operation === 'aggregate'
      ? defaultAggregateSort(groupBy, metrics)
      : entity.defaultSort || [{field: 'name', direction: 'asc'}]

  return {
    ok: true,
    plan: {
      type: 'read-query-plan',
      operation,
      entity: entity.id,
      filters,
      sort: normalizedSort,
      groupBy,
      metrics,
      having,
      limit,
      offset,
      include: Array.isArray(plan?.include)
        ? plan.include.filter(value => typeof value === 'string').slice(0, 10)
        : [],
      confidence,
      source: plan?.source || 'deterministic',
      sourceMessage: String(plan?.sourceMessage || '').trim(),
      previousPlan: plan?.previousPlan || null,
    },
    entity,
  }
}

export function mergeReadQueryPlans(previousPlan = null, patch = {}) {
  if (!previousPlan) return patch

  const replaceFamilies = new Set((patch.filters || []).map(filter => filter.field))
  const previousFilters = (previousPlan.filters || []).filter(
    filter => !replaceFamilies.has(filter.field)
  )
  const operation = patch.operation || previousPlan.operation
  const sameAggregateMode =
    operation === 'aggregate' &&
    previousPlan.operation === 'aggregate' &&
    String(patch.entity || previousPlan.entity) === String(previousPlan.entity)

  return {
    ...previousPlan,
    ...patch,
    operation,
    filters: [...previousFilters, ...(patch.filters || [])],
    sort: patch.sort?.length ? patch.sort : previousPlan.sort,
    groupBy:
      operation === 'aggregate'
        ? patch.groupBy?.length
          ? patch.groupBy
          : sameAggregateMode
            ? previousPlan.groupBy || []
            : []
        : [],
    metrics:
      operation === 'aggregate'
        ? patch.metrics?.length
          ? patch.metrics
          : sameAggregateMode
            ? previousPlan.metrics || []
            : []
        : [],
    having:
      operation === 'aggregate'
        ? patch.having?.length
          ? patch.having
          : sameAggregateMode
            ? previousPlan.having || []
            : []
        : [],
    offset: patch.offset ?? 0,
    sourceMessage: patch.sourceMessage || previousPlan.sourceMessage,
    previousPlan,
  }
}
