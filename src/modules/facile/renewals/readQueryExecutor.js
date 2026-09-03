import {buildReadEntityRecords, getReadEntityRegistry} from './readEntityRegistry.js'
import {validateReadQueryPlan} from './readQueryContract.js'
import {buildAggregateInsights} from './readQueryInsights.js'

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


function uniqueGroupValues(values = []) {
  const map = new Map()

  for (const value of values.length ? values : [null]) {
    const key = value === null || value === undefined
      ? '__null__'
      : `${typeof value}:${normalizeComparable(value)}`

    if (!map.has(key)) map.set(key, value ?? null)
  }

  return [...map.values()]
}

function buildGroupCombinations(record, groupBy = []) {
  if (!groupBy.length) return [{}]

  let combinations = [{}]

  for (const field of groupBy) {
    const values = uniqueGroupValues(getPathValues(record, field))
    const next = []

    for (const combination of combinations) {
      for (const value of values) {
        next.push({...combination, [field]: value})
      }
    }

    combinations = next
  }

  return combinations
}

function groupCombinationKey(group = {}, groupBy = []) {
  return JSON.stringify(
    groupBy.map(field => {
      const value = group[field]
      return value === null || value === undefined
        ? [field, '__null__']
        : [field, typeof value, normalizeComparable(value)]
    })
  )
}

function metricValues(records = [], field = '') {
  if (!field) return []
  return records.flatMap(record => getPathValues(record, field))
}

function computeMetric(records = [], metric = {}, fields = {}) {
  if (metric.function === 'count') return records.length

  const values = metricValues(records, metric.field)
    .filter(value => value !== null && value !== undefined && value !== '')

  if (metric.function === 'count-distinct') {
    return new Set(values.map(value => `${typeof value}:${normalizeComparable(value)}`)).size
  }

  const fieldType = fields?.[metric.field]?.type || 'string'

  if (metric.function === 'sum' || metric.function === 'avg') {
    const numbers = values
      .map(toComparableNumber)
      .filter(value => value !== null)

    if (!numbers.length) return null
    const sum = numbers.reduce((total, value) => total + value, 0)
    return metric.function === 'sum' ? sum : sum / numbers.length
  }

  if (metric.function === 'min' || metric.function === 'max') {
    if (fieldType === 'date') {
      const dated = values
        .map(value => ({value, comparable: toComparableTime(value)}))
        .filter(item => item.comparable !== null)
        .sort((first, second) => first.comparable - second.comparable)

      if (!dated.length) return null
      return metric.function === 'min' ? dated[0].value : dated[dated.length - 1].value
    }

    const numbers = values
      .map(toComparableNumber)
      .filter(value => value !== null)
      .sort((first, second) => first - second)

    if (!numbers.length) return null
    return metric.function === 'min' ? numbers[0] : numbers[numbers.length - 1]
  }

  return null
}

function getAggregateSortType(field = '', plan = {}, fields = {}) {
  const metric = (plan.metrics || []).find(item => item.id === field)

  if (!metric) return fields?.[field]?.type || 'string'
  if (['count', 'count-distinct', 'sum', 'avg'].includes(metric.function)) return 'number'
  return fields?.[metric.field]?.type || 'string'
}

function getAggregateSortValue(row = {}, field = '') {
  if (Object.prototype.hasOwnProperty.call(row.metrics || {}, field)) {
    return row.metrics[field]
  }

  if (Object.prototype.hasOwnProperty.call(row.group || {}, field)) {
    return row.group[field]
  }

  return null
}

function sortAggregateRows(rows = [], sort = [], plan = {}, fields = {}) {
  if (!sort.length) return rows

  return [...rows].sort((first, second) => {
    for (const entry of sort) {
      const firstValue = getAggregateSortValue(first, entry.field)
      const secondValue = getAggregateSortValue(second, entry.field)
      const firstMissing = firstValue === null || firstValue === undefined || firstValue === ''
      const secondMissing = secondValue === null || secondValue === undefined || secondValue === ''

      if (firstMissing !== secondMissing) return firstMissing ? 1 : -1

      const comparison = compareValues(
        firstValue,
        secondValue,
        getAggregateSortType(entry.field, plan, fields)
      )

      if (comparison !== 0) {
        return entry.direction === 'desc' ? -comparison : comparison
      }
    }

    return 0
  })
}

function aggregateRecords(records = [], plan = {}, fields = {}) {
  const grouped = new Map()

  if (!(plan.groupBy || []).length) {
    grouped.set('[]', {group: {}, records: []})
  }

  for (const record of records) {
    for (const group of buildGroupCombinations(record, plan.groupBy || [])) {
      const key = groupCombinationKey(group, plan.groupBy || [])
      const bucket = grouped.get(key) || {group, records: []}
      bucket.records.push(record)
      grouped.set(key, bucket)
    }
  }

  const rows = [...grouped.values()].map(bucket => ({
    group: bucket.group,
    metrics: Object.fromEntries(
      (plan.metrics || []).map(metric => [
        metric.id,
        computeMetric(bucket.records, metric, fields),
      ])
    ),
  })).filter(row =>
    (plan.having || []).every(filter =>
      matchesFilter(
        {value: row.metrics?.[filter.field]},
        {...filter, field: 'value'},
        {type: 'number'}
      )
    )
  )

  return sortAggregateRows(rows, plan.sort || [], plan, fields)
}


const OPERATIONAL_ENRICHMENT_FIELDS = [
  'serviceCount',
  'subscriptionCount',
  'planCount',
  'customerCount',
  'groupCount',
  'serviceTypeCount',
  'planInCount',
  'planOutCount',
  'planNames',
  'customerNames',
  'groupNames',
  'providerNames',
  'supplierNames',
  'amounts',
  'planUsages',
  'expiryYears',
  'expiryDates',
  'nextExpiry',
  'present',
]

function recordIdentity(record = {}, entityId = '') {
  const id = record?.id === null || record?.id === undefined ? '' : String(record.id)
  const name = normalizeComparable(record?.name || record?.label || '')

  if (entityId === 'plan-prices') {
    const plan = String(record?.plan?.id || normalizeComparable(record?.plan?.name || ''))
    const priceList = String(
      record?.priceListVersion?.id || normalizeComparable(record?.priceListVersion?.name || '')
    )
    const price = record?.price === null || record?.price === undefined ? '' : String(record.price)

    return {
      id,
      name,
      semanticKey: [plan, priceList, price].join('|'),
    }
  }

  return {id, name, semanticKey: ''}
}

function buildOperationalRecordIndex(records = [], entityId = '') {
  const byId = new Map()
  const byName = new Map()
  const bySemanticKey = new Map()

  for (const record of records) {
    const identity = recordIdentity(record, entityId)
    if (identity.id && !byId.has(identity.id)) byId.set(identity.id, record)
    if (identity.name && !byName.has(identity.name)) byName.set(identity.name, record)
    if (identity.semanticKey && !bySemanticKey.has(identity.semanticKey)) {
      bySemanticKey.set(identity.semanticKey, record)
    }
  }

  return {byId, byName, bySemanticKey}
}

function isOperationallyUsed(entityId, record = null) {
  if (!record) return false

  if (entityId === 'providers') {
    return record.present === true || Number(record.serviceCount || 0) > 0
  }
  if (entityId === 'customers' || entityId === 'groups') {
    return Number(record.serviceCount || 0) > 0
  }
  if (entityId === 'plans' || entityId === 'addons' || entityId === 'plan-prices') {
    return Number(record.subscriptionCount || 0) > 0 || Number(record.serviceCount || 0) > 0
  }
  if (entityId === 'resources') {
    return Number(record.planCount || 0) > 0
  }
  if (entityId === 'service-types') {
    return (
      Number(record.serviceCount || 0) > 0 ||
      Number(record.planInCount || 0) > 0 ||
      Number(record.planOutCount || 0) > 0
    )
  }
  if (entityId === 'macro-service-types') {
    return (
      Number(record.serviceCount || 0) > 0 ||
      Number(record.serviceTypeCount || 0) > 0 ||
      Number(record.planInCount || 0) > 0 ||
      Number(record.planOutCount || 0) > 0
    )
  }
  if (entityId === 'price-lists') {
    return Number(record.customerCount || 0) > 0 || Number(record.groupCount || 0) > 0
  }

  return true
}

function enrichCatalogItems(entityId, catalogItems = [], operationalRecords = []) {
  const index = buildOperationalRecordIndex(operationalRecords, entityId)

  return catalogItems.map(item => {
    const identity = recordIdentity(item, entityId)
    const operational =
      (identity.id ? index.byId.get(identity.id) : null) ||
      (identity.semanticKey ? index.bySemanticKey.get(identity.semanticKey) : null) ||
      (identity.name ? index.byName.get(identity.name) : null) ||
      null
    const enrichment = {}

    for (const field of OPERATIONAL_ENRICHMENT_FIELDS) {
      if (item?.[field] === undefined && operational?.[field] !== undefined) {
        enrichment[field] = operational[field]
      }
    }

    const used = isOperationallyUsed(entityId, operational)

    return {
      ...item,
      ...enrichment,
      usage: {
        status: used ? 'used' : 'unused',
        source: 'operational-services',
        serviceCount: Number(operational?.serviceCount || 0),
        subscriptionCount: Number(operational?.subscriptionCount || 0),
        ...(entityId === 'plan-prices'
          ? {
              planId: item?.plan?.id || null,
              priceListVersionId: item?.priceListVersion?.id || null,
            }
          : {}),
      },
    }
  })
}

export function executeReadQuery({
  plan,
  services = [],
  options = {},
  catalogResult = null,
} = {}) {
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

  if (normalizedPlan.operation === 'aggregate') {
    const filtered = records.filter(record =>
      normalizedPlan.filters.every(filter =>
        matchesFilter(record, filter, entity.fields?.[filter.field])
      )
    )
    const aggregated = aggregateRecords(filtered, normalizedPlan, entity.fields)
    const offset = normalizedPlan.offset || 0
    const limit = normalizedPlan.limit || 20
    const items = aggregated.slice(offset, offset + limit)

    return {
      ok: true,
      type: 'read-query-result',
      entity: entity.id,
      entityLabel: entity.label,
      entitySingular: entity.singular || entity.label,
      operation: 'aggregate',
      plan: normalizedPlan,
      dataSource: 'operational-services',
      sourceScope: 'used-or-referenced-data',
      total: aggregated.length,
      shown: items.length,
      offset,
      limit,
      nextOffset: offset + items.length,
      previousOffset: Math.max(offset - limit, 0),
      hasMore: offset + items.length < aggregated.length,
      items,
      aggregate: {
        groupBy: normalizedPlan.groupBy || [],
        metrics: normalizedPlan.metrics || [],
        sourceRecords: filtered.length,
      },
      analysis: buildAggregateInsights({rows: aggregated, plan: normalizedPlan}),
    }
  }

  if (
    catalogResult?.ok === true &&
    catalogResult?.source === 'catalog' &&
    String(catalogResult?.entity || '') === entity.id
  ) {
    const items = enrichCatalogItems(entity.id, catalogResult.items || [], records)

    return {
      ok: true,
      type: 'read-query-result',
      entity: entity.id,
      entityLabel: entity.label,
      entitySingular: entity.singular || entity.label,
      operation: normalizedPlan.operation,
      plan: normalizedPlan,
      dataSource: 'catalog',
      sourceScope: catalogResult.sourceScope || 'complete-master-data',
      catalogVersion: catalogResult.catalogVersion || null,
      total: Number(catalogResult.total || 0),
      shown: normalizedPlan.operation === 'count' ? 0 : items.length,
      offset: Number(catalogResult.offset || 0),
      limit: Number(catalogResult.limit || 0),
      nextOffset: Number(catalogResult.nextOffset || 0),
      previousOffset: Number(catalogResult.previousOffset || 0),
      hasMore: catalogResult.hasMore === true,
      items: normalizedPlan.operation === 'count' ? [] : items,
    }
  }
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
      entitySingular: entity.singular || entity.label,
      operation: 'count',
      plan: normalizedPlan,
      dataSource: 'operational-services',
      sourceScope: 'used-or-referenced-data',
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
    entitySingular: entity.singular || entity.label,
    operation: normalizedPlan.operation,
    plan: normalizedPlan,
    dataSource: 'operational-services',
    sourceScope: 'used-or-referenced-data',
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
