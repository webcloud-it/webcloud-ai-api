import {callOllamaChat} from '../../../core/providers/ollamaProvider.js'
import {
  DEFAULT_READ_QUERY_LIMIT,
  mergeReadQueryPlans,
  validateReadQueryPlan,
} from './readQueryContract.js'
import {
  findReadEntityByAlias,
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

const ANALYTICAL_READ_PATTERN =
  /\b(?:raggrupp|aggreg|classific|ranking|top|maggior|minore|minor|massim|minim|media|medie|somma|distint|distribuz|confront|correl|per\s+(?:ogni|ciascun|ciascuna)|piu|meno|primi\s+\d{1,2}|prime\s+\d{1,2})\b/i

export function isAnalyticalReadQueryRequest(message = '') {
  const text = normalizeText(message)
  if (!text) return false

  return (
    ANALYTICAL_READ_PATTERN.test(text) ||
    /\b(?:quanti|quante|conteggio|numero)\b[\s\S]{0,80}\bper\b/i.test(text) ||
    /\bper\b[\s\S]{0,80}\b(?:quanti|quante|conteggio|numero)\b/i.test(text)
  )
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

function parsePagination(message = '', previousState = null) {
  if (!previousState) return null
  const text = normalizeText(message)

  if (/^(?:e\s+)?(?:altri|altre|prossimi|prossime|successivi|successive|seguenti|ancora|continua|prosegui|vai avanti|avanti)(?:\s+\d{1,2})?[?.!]*$/i.test(text)) {
    const explicit = text.match(/\b(\d{1,2})\b/)?.[1]
    const limit = explicit ? Math.min(Math.max(Number(explicit), 1), 50) : previousState.limit
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

function extractLimit(text = '') {
  const match = text.match(/\b(?:primi|prime|mostra|mostrami|elenca|elencami|dammi)\s+(\d{1,2})\b/i)
  if (match?.[1]) return Math.min(Math.max(Number(match[1]), 1), 50)
  return DEFAULT_READ_QUERY_LIMIT
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
    if (/\bnon collegat[oi]\s+(?:a\s+)?plesk\b|\bsenza plesk\b/i.test(text)) {
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
  const definitions = getReadEntityDefinitions()
  const registrySummary = definitions.map(definition => ({
    id: definition.id,
    label: definition.label,
    aliases: definition.aliases,
    fields: Object.fromEntries(
      Object.entries(definition.fields || {}).map(([field, config]) => [field, config?.type || 'string'])
    ),
  }))

  const systemPrompt = [
    'Sei il planner strutturato di sola lettura del modulo rinnovi Webcloud.',
    'Non rispondere all’utente e non accedere a database o API.',
    'Trasforma la richiesta in un piano JSON usando esclusivamente entità, campi e operatori consentiti.',
    'Le action, le conferme, gli annullamenti e le diagnostiche sono gestiti prima di questo planner.',
    'Non inventare nomi, filtri o valori non presenti nella richiesta.',
    'Se la richiesta è un seguito, modifica il previousPlan senza perdere filtri, raggruppamenti o metriche ancora pertinenti.',
    'Usa operation=aggregate soltanto quando servono raggruppamenti o metriche calcolate; se una metrica è già un campo numerico dell’entità preferisci list + sort.',
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
    outputSchema: {
      operation: 'list | count | detail | aggregate',
      entity: 'entity id',
      filters: [{field: 'allowed field', operator: 'allowed operator', value: 'scalar | array | {start,end}'}],
      groupBy: ['allowed field; only for aggregate'],
      metrics: [{id: 'short stable id', function: 'count | count-distinct | sum | avg | min | max', field: 'allowed field or null'}],
      sort: [{field: 'allowed entity field, groupBy field or metric id', direction: 'asc | desc'}],
      limit: '1..50',
      offset: '>=0',
      confidence: '0..1',
    },
  }

  const raw = await callLlm({
    timeoutMs: 7000,
    messages: [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: JSON.stringify(payload)},
    ],
  })

  const parsed = extractJsonObject(raw)
  if (!parsed || Number(parsed.confidence || 0) < 0.7) return null

  return {
    ...parsed,
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
} = {}) {
  const rememberedState = getRememberedReadQueryContext({actorToken})
  const previousState = getPreviousReadQueryState(history, {
    fallbackState: rememberedState,
  })
  const registry = getReadEntityRegistry()
  const deterministic = buildDeterministicPlan(
    message,
    previousState,
    resolvedDetailTarget,
    readUtterance
  )

  const analyticalRequest = isAnalyticalReadQueryRequest(message)

  if (deterministic && (!analyticalRequest || deterministic.source === 'follow-up-pagination')) {
    const validation = validateReadQueryPlan(deterministic, registry)
    if (validation.ok) return validation.plan
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

    if (!validation.ok) return null
    if (validation.plan.entity === 'services' && validation.plan.operation !== 'aggregate') {
      return null
    }

    return validation.plan
  } catch {
    return null
  }
}
