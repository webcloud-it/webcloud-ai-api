import {buildReadEntityRecords, getReadEntityRegistry} from './readEntityRegistry.js'
import {validateReadQueryPlan} from './readQueryContract.js'

function normalizeComparable(value) {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function getPathValues(source, path = '') {
  const segments = String(path || '')
    .split('.')
    .filter(Boolean)

  let values = [source]

  for (const segment of segments) {
    values = values.flatMap(value => {
      if (Array.isArray(value)) {
        return value.flatMap(item => {
          const next = item?.[segment]
          return Array.isArray(next) ? next : [next]
        })
      }

      const next = value?.[segment]
      return Array.isArray(next) ? next : [next]
    })
  }

  return values.flat(Infinity).filter(value => value !== undefined)
}

function toComparableNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function toComparableTime(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}

function anyValue(values, predicate) {
  return values.some(value => predicate(value))
}

function matchesFilter(record, filter, fieldDefinition = {}) {
  const values = getPathValues(record, filter.field)
  const type = fieldDefinition?.type || 'string'
  const operator = filter.operator
  const expected = filter.value

  if (operator === 'exists') {
    return values.some(value => value !== null && value !== undefined && value !== '')
  }

  if (operator === 'not-exists') {
    return !values.some(value => value !== null && value !== undefined && value !== '')
  }

  if (operator === 'truthy') {
    return values.some(Boolean)
  }

  if (operator === 'falsey') {
    return values.length === 0 || values.every(value => !value)
  }

  if (operator === 'in') {
    const expectedValues = (Array.isArray(expected) ? expected : [expected]).map(normalizeComparable)
    return anyValue(values, value => expectedValues.includes(normalizeComparable(value)))
  }

  if (operator === 'between') {
    if (type === 'date') {
      const start = toComparableTime(expected?.start)
      const end = toComparableTime(expected?.end)
      if (start === null || end === null) return false
      return anyValue(values, value => {
        const time = toComparableTime(value)
        return time !== null && time >= start && time <= end
      })
    }

    const start = toComparableNumber(expected?.start)
    const end = toComparableNumber(expected?.end)
    if (start === null || end === null) return false
    return anyValue(values, value => {
      const number = toComparableNumber(value)
      return number !== null && number >= start && number <= end
    })
  }

  if (operator === 'gte' || operator === 'lte') {
    if (type === 'date') {
      const expectedTime = toComparableTime(expected)
      if (expectedTime === null) return false
      return anyValue(values, value => {
        const time = toComparableTime(value)
        if (time === null) return false
        return operator === 'gte' ? time >= expectedTime : time <= expectedTime
      })
    }

    const expectedNumber = toComparableNumber(expected)
    if (expectedNumber === null) return false
    return anyValue(values, value => {
      const number = toComparableNumber(value)
      if (number === null) return false
      return operator === 'gte' ? number >= expectedNumber : number <= expectedNumber
    })
  }

  const expectedText = normalizeComparable(expected)

  if (operator === 'equals') {
    return anyValue(values, value => normalizeComparable(value) === expectedText)
  }

  if (operator === 'not-equals') {
    return !anyValue(values, value => normalizeComparable(value) === expectedText)
  }

  if (operator === 'contains') {
    return anyValue(values, value => normalizeComparable(value).includes(expectedText))
  }

  if (operator === 'not-contains') {
    return !anyValue(values, value => normalizeComparable(value).includes(expectedText))
  }

  return true
}

function compareValues(first, second, type = 'string') {
  if (type === 'number') {
    return (toComparableNumber(first) ?? Number.POSITIVE_INFINITY) -
      (toComparableNumber(second) ?? Number.POSITIVE_INFINITY)
  }

  if (type === 'date') {
    return (toComparableTime(first) ?? Number.POSITIVE_INFINITY) -
      (toComparableTime(second) ?? Number.POSITIVE_INFINITY)
  }

  return normalizeComparable(first).localeCompare(normalizeComparable(second), 'it')
}

function firstSortValue(record, field) {
  return getPathValues(record, field)[0] ?? null
}

function sortRecords(records, sort = [], fields = {}) {
  if (!sort.length) return records

  return [...records].sort((first, second) => {
    for (const entry of sort) {
      const comparison = compareValues(
        firstSortValue(first, entry.field),
        firstSortValue(second, entry.field),
        fields?.[entry.field]?.type
      )

      if (comparison !== 0) {
        return entry.direction === 'desc' ? -comparison : comparison
      }
    }

    return 0
  })
}

export function executeReadQuery({plan, services = [], options = {}} = {}) {
  const registry = getReadEntityRegistry()
  const validation = validateReadQueryPlan(plan, registry)

  if (!validation.ok) {
    return {
      ok: false,
      error: validation.message,
      reason: validation.reason,
    }
  }

  const normalizedPlan = validation.plan
  const entity = validation.entity
  const records = buildReadEntityRecords(entity.id, {services, options})
  const filtered = records.filter(record =>
    normalizedPlan.filters.every(filter =>
      matchesFilter(record, filter, entity.fields?.[filter.field])
    )
  )
  const sorted = sortRecords(filtered, normalizedPlan.sort, entity.fields)

  if (normalizedPlan.operation === 'count') {
    return {
      ok: true,
      type: 'read-query-result',
      entity: entity.id,
      entityLabel: entity.label,
      operation: 'count',
      plan: normalizedPlan,
      total: sorted.length,
      shown: 0,
      offset: 0,
      limit: 0,
      hasMore: false,
      items: [],
    }
  }

  const offset = normalizedPlan.offset || 0
  const limit = normalizedPlan.limit || 20
  const items = sorted.slice(offset, offset + limit)

  return {
    ok: true,
    type: 'read-query-result',
    entity: entity.id,
    entityLabel: entity.label,
    operation: normalizedPlan.operation,
    plan: normalizedPlan,
    total: sorted.length,
    shown: items.length,
    offset,
    limit,
    nextOffset: offset + items.length,
    previousOffset: Math.max(offset - limit, 0),
    hasMore: offset + items.length < sorted.length,
    items,
  }
}
