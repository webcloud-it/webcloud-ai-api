import {env} from '../../../config/env.js'
import {callOllamaJson} from '../../../core/providers/ollamaProvider.js'
import {normalizeComparableText} from '../../../utils/text.js'

const MAX_ROWS = 5000
const PAGE_SIZE = 250

const FIELD_DEFINITIONS = Object.freeze({
  companyName: {label: 'azienda', type: 'string'},
  plan: {label: 'piano', type: 'string'},
  crmLinked: {label: 'collegamento CRM', type: 'boolean'},
  lightAccessDisabled: {label: 'accesso Light disabilitato', type: 'boolean'},
  campaigns: {label: 'campagne', type: 'number'},
  campaignsSent: {label: 'campagne inviate', type: 'number'},
  campaignsQueued: {label: 'campagne in coda', type: 'number'},
  contacts: {label: 'contatti', type: 'number'},
  blacklistedContacts: {label: 'contatti in blacklist', type: 'number'},
  lists: {label: 'liste', type: 'number'},
  attributes: {label: 'attributi', type: 'number'},
  segments: {label: 'segmenti', type: 'number'},
  templates: {label: 'template', type: 'number'},
  forms: {label: 'form', type: 'number'},
  automations: {label: 'automazioni', type: 'number'},
  senders: {label: 'mittenti', type: 'number'},
})

const NUMERIC_ALIASES = Object.freeze([
  {field: 'campaignsSent', pattern: /campagn\w*\s+inviat\w*/i},
  {field: 'campaignsQueued', pattern: /campagn\w*\s+(?:in\s+coda|accodat\w*|queued)/i},
  {field: 'blacklistedContacts', pattern: /contatt\w*\s+(?:in\s+)?blacklist/i},
  {field: 'campaigns', pattern: /campagn\w*/i},
  {field: 'contacts', pattern: /contatt\w*/i},
  {field: 'lists', pattern: /list[ae]/i},
  {field: 'attributes', pattern: /attribut\w*/i},
  {field: 'segments', pattern: /segment\w*/i},
  {field: 'templates', pattern: /template/i},
  {field: 'forms', pattern: /\bform\b/i},
  {field: 'automations', pattern: /automazion\w*/i},
  {field: 'senders', pattern: /mittent\w*/i},
])

const ANALYTICAL_PATTERN = /\b(?:confront\w*|compar\w*|differenz\w*|media|medi[ae]|somma|totale|raggrupp\w*|distribuz\w*|per\s+(?:piano|ogni|ciascun\w*)|esclud\w*|tranne|eccetto|almeno|massimo|piu\s+di|meno\s+di)\b/i
const OPERATORS = new Set(['equals', 'not-equals', 'contains', 'not-contains', 'gt', 'gte', 'lt', 'lte', 'truthy', 'falsey'])
const METRIC_FUNCTIONS = new Set(['count', 'sum', 'avg', 'min', 'max'])

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function planName(raw = {}) {
  return raw.subscription_config?.plan?.name || raw.plan?.name || raw.plan_name || raw.subscription_plan || 'Non configurato'
}

export function sanitizeAnalyticsUser(raw = {}) {
  return {
    id: raw.id || null,
    companyName: raw.company_name || raw.name || String(raw.id || '—'),
    plan: planName(raw),
    crmLinked: Boolean(raw.crm_customers_id || raw.subscription_config?.crm_customers_id),
    lightAccessDisabled: raw.light_access?.disabled === true,
    campaigns: number(raw.total_campaigns),
    campaignsSent: number(raw.sent_campaigns),
    campaignsQueued: number(raw.queued_campaigns),
    contacts: number(raw.total_contacts ?? raw.contacts_count),
    blacklistedContacts: number(raw.blacklisted_contacts),
    lists: number(raw.total_lists),
    attributes: number(raw.total_attributes),
    segments: number(raw.total_segments),
    templates: number(raw.total_templates),
    forms: number(raw.total_forms),
    automations: number(raw.total_automations),
    senders: number(raw.total_senders),
  }
}

export function isSendInItalyUserAnalyticsRequest(message = '') {
  const text = normalizeComparableText(message)
  return /\b(?:utent\w*|client\w*|account|aziend\w*|pian\w*)\b/i.test(text) && ANALYTICAL_PATTERN.test(text)
}

function mentionedNumericFields(text = '') {
  return NUMERIC_ALIASES.filter(item => item.pattern.test(text)).map(item => item.field)
}

function parseLimit(text = '', fallback = 10) {
  const words = new Map([
    ['uno', 1], ['una', 1], ['due', 2], ['tre', 3], ['quattro', 4], ['cinque', 5],
    ['sei', 6], ['sette', 7], ['otto', 8], ['nove', 9], ['dieci', 10],
  ])
  const token = text.match(/\b(?:prim\w*|top)\s+(\d{1,2}|uno|una|due|tre|quattro|cinque|sei|sette|otto|nove|dieci)\b/i)?.[1]
  const value = /^\d+$/.test(token || '') ? Number(token) : words.get(token || '')
  return Math.min(Math.max(value || fallback, 1), 50)
}

function parseThresholdFilters(text = '') {
  const filters = []
  for (const alias of NUMERIC_ALIASES) {
    const source = alias.pattern.source
    const after = text.match(new RegExp(`${source}\\s+(?:pari\\s+o\\s+)?(almeno|oltre|piu\\s+di|massimo|fino\\s+a|meno\\s+di)\\s+(\\d+)`, 'i'))
    const before = text.match(new RegExp(`(almeno|oltre|piu\\s+di|massimo|fino\\s+a|meno\\s+di)\\s+(\\d+)\\s+${source}`, 'i'))
    const match = after || before
    if (!match) continue
    const [, phrase, rawValue] = match
    const operator = /almeno/i.test(phrase) ? 'gte' : /oltre|piu/i.test(phrase) ? 'gt' : /massimo|fino/i.test(phrase) ? 'lte' : 'lt'
    filters.push({field: alias.field, operator, value: Number(rawValue)})
  }
  return filters
}

function extractPlanFilter(text = '') {
  const match = text.match(/\bpiano\s+["“”']?([a-z0-9][a-z0-9 _.-]{1,50})/i)
  if (!match) return null
  const value = match[1]
    .replace(/^(?:e|ma|per|ogni|ciascun\w*)\b.*/i, '')
    .replace(/\s+(?:con|che|e|ma|ordin\w*|raggrupp\w*|esclud\w*).*/i, '')
    .trim()
  return value && !/^(?:per|ogni|ciascun\w*)$/i.test(value)
    ? {field: 'plan', operator: 'contains', value}
    : null
}

function extractExcludedCompany(text = '') {
  const match = text.match(/\b(?:esclud\w*|tranne|eccetto)\s+["“”']?([^"“”',;?.]{2,80})/i)
  if (!match) return null
  const value = match[1].replace(/\s+(?:e|poi|dal|dalla|ordin\w*|confront\w*).*/i, '').trim()
  return value ? {field: 'companyName', operator: 'not-contains', value} : null
}

export function planDeterministicUserAnalytics(message = '') {
  const text = normalizeComparableText(message)
  if (!isSendInItalyUserAnalyticsRequest(text)) return null

  const fields = mentionedNumericFields(text)
  const filters = [extractPlanFilter(text), extractExcludedCompany(text), ...parseThresholdFilters(text)].filter(Boolean)
  const groupByPlan = /(?:raggrupp\w*|distribuz\w*|per\s+(?:ogni|ciascun\w*|piano))[^.]{0,40}pian|\bper\s+piano\b/i.test(text)
  const asksAverage = /\bmedi[aoe]\b/i.test(text)
  const asksSum = /\b(?:somma|totale)\b/i.test(text)

  if (groupByPlan) {
    const field = fields[0]
    const metrics = [{id: 'users', function: 'count', field: null}]
    if (field && asksAverage) metrics.push({id: `avg_${field}`, function: 'avg', field})
    else if (field && asksSum) metrics.push({id: `sum_${field}`, function: 'sum', field})
    const rankingMetric = metrics.at(-1).id
    return {operation: 'aggregate', filters, groupBy: ['plan'], metrics, sort: [{field: rankingMetric, direction: 'desc'}], limit: parseLimit(text, 20), comparisonFields: []}
  }

  if (/\b(?:confront\w*|compar\w*|differenz\w*)\b/i.test(text) && fields.length) {
    return {operation: 'compare', filters, groupBy: [], metrics: [], sort: [{field: fields[0], direction: /\bmeno\b/i.test(text) ? 'asc' : 'desc'}], limit: parseLimit(text, 2), comparisonFields: fields}
  }

  if (filters.some(filter => FIELD_DEFINITIONS[filter.field]?.type === 'number')) {
    return {operation: /\bquant[ei]\b|\bconteggio\b/i.test(text) ? 'count' : 'list', filters, groupBy: [], metrics: [], sort: fields[0] ? [{field: fields[0], direction: 'desc'}] : [], limit: parseLimit(text, 20), comparisonFields: fields}
  }

  return null
}

function normalizePlan(raw = {}) {
  const operation = ['list', 'count', 'aggregate', 'compare'].includes(raw.operation) ? raw.operation : null
  if (!operation) return null
  const rawFilters = Array.isArray(raw.filters) ? raw.filters : []
  const filters = rawFilters.slice(0, 8).filter(filter =>
    FIELD_DEFINITIONS[filter?.field] && OPERATORS.has(filter?.operator)
  ).map(filter => ({field: filter.field, operator: filter.operator, value: filter.value}))
  const rawGroupBy = Array.isArray(raw.groupBy) ? raw.groupBy : []
  const groupBy = rawGroupBy.filter(field => ['plan', 'crmLinked', 'lightAccessDisabled'].includes(field)).slice(0, 2)
  const rawMetrics = Array.isArray(raw.metrics) ? raw.metrics : []
  const metrics = rawMetrics.filter(metric =>
    typeof metric?.id === 'string' && METRIC_FUNCTIONS.has(metric?.function) &&
    (metric.function === 'count' ? metric.field == null : FIELD_DEFINITIONS[metric.field]?.type === 'number')
  ).slice(0, 4).map(metric => ({id: metric.id.slice(0, 40), function: metric.function, field: metric.field ?? null}))
  if (rawFilters.length > 8 || filters.length !== rawFilters.length) return null
  if (rawGroupBy.length > 2 || groupBy.length !== rawGroupBy.length) return null
  if (rawMetrics.length > 4 || metrics.length !== rawMetrics.length) return null
  if (operation === 'aggregate' && (!groupBy.length || !metrics.length)) return null
  const metricIds = new Set(metrics.map(metric => metric.id))
  const rawSort = Array.isArray(raw.sort) ? raw.sort : []
  const sort = rawSort.filter(item =>
    (FIELD_DEFINITIONS[item?.field] || metricIds.has(item?.field)) && ['asc', 'desc'].includes(item?.direction)
  ).slice(0, 3).map(item => ({field: item.field, direction: item.direction}))
  const rawComparisonFields = Array.isArray(raw.comparisonFields) ? raw.comparisonFields : []
  const comparisonFields = rawComparisonFields
    .filter(field => FIELD_DEFINITIONS[field]?.type === 'number').slice(0, 6)
  if (rawSort.length > 3 || sort.length !== rawSort.length) return null
  if (rawComparisonFields.length > 6 || comparisonFields.length !== rawComparisonFields.length) return null
  return {
    operation,
    filters,
    groupBy,
    metrics,
    sort,
    limit: Math.min(Math.max(Number(raw.limit) || (operation === 'compare' ? 2 : 20), 1), 50),
    comparisonFields,
    source: raw.source === 'semantic' ? 'semantic' : 'deterministic',
  }
}

export async function planSendInItalyUserAnalytics({message, callModel = callOllamaJson} = {}) {
  const deterministic = planDeterministicUserAnalytics(message)
  if (deterministic) return {...deterministic, source: 'deterministic'}
  if (!isSendInItalyUserAnalyticsRequest(message)) return null

  try {
    const raw = await callModel({
      timeoutMs: Math.min(Math.max(env.ollamaReadPlannerTimeoutMs, 8000), 15000),
      options: {temperature: 0, num_predict: 500},
      messages: [
        {
          role: 'system',
          content: [
            'Sei il planner di sola lettura degli utenti Send in Italy.',
            'Trasforma la richiesta in un piano JSON. Non rispondere alla domanda e non inventare campi.',
            `Campi: ${Object.entries(FIELD_DEFINITIONS).map(([key, value]) => `${key}(${value.type})`).join(', ')}.`,
            'operation: list, count, aggregate o compare.',
            'Operatori filtri: equals, not-equals, contains, not-contains, gt, gte, lt, lte, truthy, falsey.',
            'Per aggregate usa groupBy (plan, crmLinked o lightAccessDisabled) e metrics con function count, sum, avg, min o max.',
            'Per compare ordina i record, limita il campione e indica comparisonFields numerici.',
            'Restituisci solo JSON con operation, filters, groupBy, metrics, sort, limit, comparisonFields.',
          ].join(' '),
        },
        {role: 'user', content: String(message || '').slice(0, 1200)},
      ],
    })
    const plan = normalizePlan(raw)
    return plan ? {...plan, source: 'semantic'} : null
  } catch {
    return null
  }
}

async function fetchAllUsers({token, services}) {
  const first = await services.getUsers({token, page: 1, limit: PAGE_SIZE})
  const items = Array.isArray(first?.data) ? [...first.data] : []
  const total = Math.min(number(first?.meta?.total ?? items.length), MAX_ROWS)
  const pageCount = Math.ceil(total / PAGE_SIZE)
  if (pageCount > 1) {
    const pages = await Promise.all(Array.from({length: pageCount - 1}, (_, index) =>
      services.getUsers({token, page: index + 2, limit: PAGE_SIZE})
    ))
    for (const page of pages) if (Array.isArray(page?.data)) items.push(...page.data)
  }
  return {items: items.slice(0, MAX_ROWS).map(sanitizeAnalyticsUser), total, truncated: total >= MAX_ROWS}
}

function compareValue(actual, operator, expected) {
  if (operator === 'truthy') return Boolean(actual)
  if (operator === 'falsey') return !actual
  if (operator === 'contains' || operator === 'not-contains') {
    const contains = normalizeComparableText(actual).includes(normalizeComparableText(expected))
    return operator === 'contains' ? contains : !contains
  }
  if (operator === 'equals' || operator === 'not-equals') {
    const equals = typeof actual === 'string'
      ? normalizeComparableText(actual) === normalizeComparableText(expected)
      : actual === expected
    return operator === 'equals' ? equals : !equals
  }
  const left = number(actual)
  const right = number(expected)
  return operator === 'gt' ? left > right : operator === 'gte' ? left >= right : operator === 'lt' ? left < right : left <= right
}

function sortRows(rows, sort = []) {
  return [...rows].sort((left, right) => {
    for (const item of sort) {
      const a = left[item.field]
      const b = right[item.field]
      const result = typeof a === 'number' && typeof b === 'number'
        ? a - b
        : String(a ?? '').localeCompare(String(b ?? ''), 'it', {sensitivity: 'base'})
      if (result) return item.direction === 'desc' ? -result : result
    }
    return left.companyName.localeCompare(right.companyName, 'it', {sensitivity: 'base'})
  })
}

function metricValue(rows, metric) {
  if (metric.function === 'count') return rows.length
  const values = rows.map(row => number(row[metric.field]))
  if (!values.length) return 0
  if (metric.function === 'sum') return values.reduce((sum, value) => sum + value, 0)
  if (metric.function === 'avg') return values.reduce((sum, value) => sum + value, 0) / values.length
  if (metric.function === 'min') return Math.min(...values)
  return Math.max(...values)
}

function aggregateRows(rows, plan) {
  const groups = new Map()
  for (const row of rows) {
    const group = Object.fromEntries(plan.groupBy.map(field => [field, row[field]]))
    const key = JSON.stringify(group)
    const current = groups.get(key) || {group, source: []}
    current.source.push(row)
    groups.set(key, current)
  }
  return [...groups.values()].map(item => ({
    group: item.group,
    values: Object.fromEntries(plan.metrics.map(metric => [metric.id, metricValue(item.source, metric)])),
  }))
}

function sortAggregates(rows, sort = []) {
  return [...rows].sort((left, right) => {
    for (const item of sort) {
      const a = left.values[item.field] ?? left.group[item.field]
      const b = right.values[item.field] ?? right.group[item.field]
      const result = typeof a === 'number' && typeof b === 'number' ? a - b : String(a ?? '').localeCompare(String(b ?? ''), 'it')
      if (result) return item.direction === 'desc' ? -result : result
    }
    return 0
  })
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toLocaleString('it-IT', {maximumFractionDigits: 2})
}

function formatFilterSummary(plan) {
  if (!plan.filters.length) return ''
  return ` dopo ${plan.filters.length} ${plan.filters.length === 1 ? 'filtro verificato' : 'filtri verificati'}`
}

function formatResult({plan, rows, aggregates, sourceCount, matchedCount}) {
  if (plan.operation === 'count') return `Risultano ${matchedCount} utenti Send in Italy${formatFilterSummary(plan)} (su ${sourceCount} analizzati).`
  if (plan.operation === 'aggregate') {
    if (!aggregates.length) return 'Non risultano gruppi corrispondenti ai filtri richiesti.'
    return [
      `Analisi utenti Send in Italy per ${plan.groupBy.map(field => FIELD_DEFINITIONS[field].label).join(' e ')} (${sourceCount} utenti analizzati):`,
      ...aggregates.slice(0, plan.limit).map((item, index) => {
        const group = Object.entries(item.group).map(([field, value]) => `${FIELD_DEFINITIONS[field].label} ${value}`).join(', ')
        const values = Object.entries(item.values).map(([id, value]) => `${id.replaceAll('_', ' ')}: ${formatNumber(value)}`).join('; ')
        return `${index + 1}. ${group} — ${values}`
      }),
    ].join('\n')
  }
  if (!rows.length) return `Non risultano utenti Send in Italy corrispondenti ai filtri richiesti (su ${sourceCount} analizzati).`
  const fields = [...new Set([...(plan.comparisonFields || []), ...plan.sort.map(item => item.field)])].filter(field => FIELD_DEFINITIONS[field]?.type === 'number')
  const lines = rows.slice(0, plan.limit).map((row, index) => {
    const values = fields.map(field => `${FIELD_DEFINITIONS[field].label}: ${formatNumber(row[field])}`).join('; ')
    return `${index + 1}. ${row.companyName} — piano ${row.plan}${values ? `; ${values}` : ''}`
  })
  if (plan.operation !== 'compare' || rows.length < 2) return [`Utenti Send in Italy trovati: ${rows.length} (su ${sourceCount} analizzati).`, ...lines].join('\n')
  const [first, second] = rows
  const differences = fields.map(field => {
    const delta = first[field] - second[field]
    const percentage = second[field] !== 0 ? Math.abs(delta / second[field]) * 100 : null
    return `${FIELD_DEFINITIONS[field].label}: ${first.companyName} ${delta >= 0 ? 'ha' : 'ha'} ${formatNumber(Math.abs(delta))} ${delta >= 0 ? 'in più' : 'in meno'}${percentage === null ? '' : ` (${formatNumber(percentage)}%)`}`
  })
  return ['Confronto verificato:', ...lines, differences.length ? `Differenze:\n${differences.map(item => `- ${item}`).join('\n')}` : 'I due utenti sono stati ordinati secondo il criterio richiesto.'].join('\n')
}

export async function executeSendInItalyUserAnalytics({message, token, services, plan = null} = {}) {
  const resolvedPlan = normalizePlan(plan || await planSendInItalyUserAnalytics({message}))
  if (!resolvedPlan) return null
  const dataset = await fetchAllUsers({token, services})
  const filtered = dataset.items.filter(row => resolvedPlan.filters.every(filter => compareValue(row[filter.field], filter.operator, filter.value)))
  let rows = []
  let aggregates = []
  if (resolvedPlan.operation === 'aggregate') {
    aggregates = sortAggregates(aggregateRows(filtered, resolvedPlan), resolvedPlan.sort).slice(0, resolvedPlan.limit)
  } else {
    rows = resolvedPlan.operation === 'count'
      ? []
      : sortRows(filtered, resolvedPlan.sort).slice(0, resolvedPlan.limit)
  }
  return {
    ok: true,
    intent: 'sendinitaly-user-analytics',
    source: resolvedPlan.source === 'semantic' ? 'tool-semantic' : 'tool-fast',
    reply: formatResult({plan: resolvedPlan, rows, aggregates, sourceCount: dataset.items.length, matchedCount: filtered.length}),
    data: {
      type: 'sendinitaly-user-analytics',
      plan: resolvedPlan,
      sourceCount: dataset.items.length,
      matchedCount: filtered.length,
      truncated: dataset.truncated,
      items: rows,
      groups: aggregates,
      actions: [{id: 'navigate', label: 'Apri utenti', path: '/sendinitaly/users'}],
    },
    meta: {moduleId: 'facile.sendinitaly'},
  }
}
