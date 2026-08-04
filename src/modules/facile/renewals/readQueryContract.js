const ALLOWED_OPERATIONS = new Set(['list', 'count', 'detail'])
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

export const DEFAULT_READ_QUERY_LIMIT = 20
export const MAX_READ_QUERY_LIMIT = 50

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

  const operation = ALLOWED_OPERATIONS.has(plan?.operation) ? plan.operation : 'list'
  const allowedFields = new Set(Object.keys(entity.fields || {}))
  const filters = (Array.isArray(plan?.filters) ? plan.filters : [])
    .map(filter => normalizeFilter(filter, allowedFields))
    .filter(Boolean)
  const sort = normalizeSort(plan?.sort, allowedFields)
  const limit = clampInteger(
    operation === 'count' ? 0 : plan?.limit,
    operation === 'detail' ? 10 : DEFAULT_READ_QUERY_LIMIT,
    {min: operation === 'count' ? 0 : 1, max: MAX_READ_QUERY_LIMIT}
  )
  const offset = clampInteger(plan?.offset, 0, {min: 0})
  const confidence = Number.isFinite(Number(plan?.confidence))
    ? Math.max(0, Math.min(1, Number(plan.confidence)))
    : 1

  return {
    ok: true,
    plan: {
      type: 'read-query-plan',
      operation,
      entity: entity.id,
      filters,
      sort: sort.length ? sort : entity.defaultSort || [{field: 'name', direction: 'asc'}],
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

  return {
    ...previousPlan,
    ...patch,
    filters: [...previousFilters, ...(patch.filters || [])],
    sort: patch.sort?.length ? patch.sort : previousPlan.sort,
    offset: patch.offset ?? 0,
    sourceMessage: patch.sourceMessage || previousPlan.sourceMessage,
    previousPlan,
  }
}
