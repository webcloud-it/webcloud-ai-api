function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return null
  const factor = 10 ** digits
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor
}

function median(values = []) {
  if (!values.length) return null
  const sorted = [...values].sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function summarizeGroup(group = {}, groupBy = []) {
  return Object.fromEntries(
    groupBy.map(field => [field, group?.[field] ?? null])
  )
}

function findMetricSort(plan = {}, metricId = '') {
  return (plan.sort || []).find(entry => entry.field === metricId) || null
}

function rankMetricRows(rows = [], metricId = '', direction = 'desc') {
  return rows
    .map(row => ({
      group: row.group || {},
      value: Number(row?.metrics?.[metricId]),
    }))
    .filter(item => Number.isFinite(item.value))
    .sort((first, second) => {
      const difference = first.value - second.value
      return direction === 'asc' ? difference : -difference
    })
}

function buildMetricSummary({rows = [], metric = {}, plan = {}} = {}) {
  const sort = findMetricSort(plan, metric.id)
  const rankingDirection = sort?.direction || 'desc'
  const ranked = rankMetricRows(rows, metric.id, rankingDirection)
  if (!ranked.length) return null

  const values = ranked.map(item => item.value)
  const total = values.reduce((sum, value) => sum + value, 0)
  const ascending = [...ranked].sort((first, second) => first.value - second.value)
  const first = ranked[0] || null
  const second = ranked[1] || null
  const gapAbsolute = first && second ? Math.abs(first.value - second.value) : null
  const gapPercentage = first && second && second.value !== 0
    ? Math.abs((first.value - second.value) / second.value) * 100
    : null
  const topCount = Math.min(3, ranked.length)
  const topTotal = ranked
    .slice(0, topCount)
    .reduce((sum, item) => sum + Math.max(item.value, 0), 0)

  return {
    metricId: metric.id,
    function: metric.function,
    field: metric.field || null,
    valuesCount: values.length,
    total: round(total),
    average: round(total / values.length),
    median: round(median(values)),
    minimum: {
      group: summarizeGroup(ascending[0].group, plan.groupBy || []),
      value: round(ascending[0].value),
    },
    maximum: {
      group: summarizeGroup(ascending.at(-1).group, plan.groupBy || []),
      value: round(ascending.at(-1).value),
    },
    ranking: {
      direction: rankingDirection,
      first: first
        ? {group: summarizeGroup(first.group, plan.groupBy || []), value: round(first.value)}
        : null,
      second: second
        ? {group: summarizeGroup(second.group, plan.groupBy || []), value: round(second.value)}
        : null,
      gapAbsolute: round(gapAbsolute),
      gapPercentage: round(gapPercentage),
      topShare: total > 0 ? round((Math.max(first?.value || 0, 0) / total) * 100) : null,
      topGroupCount: topCount,
      topGroupsShare: total > 0 ? round((topTotal / total) * 100) : null,
    },
  }
}

export function buildAggregateInsights({rows = [], plan = {}} = {}) {
  if (!Array.isArray(rows) || !rows.length || plan.operation !== 'aggregate') return null

  const metricSummaries = (plan.metrics || [])
    .map(metric => buildMetricSummary({rows, metric, plan}))
    .filter(Boolean)

  if (!metricSummaries.length) return null

  return {
    type: 'verified-aggregate-analysis',
    groupsAnalyzed: rows.length,
    groupBy: plan.groupBy || [],
    metricSummaries,
  }
}
