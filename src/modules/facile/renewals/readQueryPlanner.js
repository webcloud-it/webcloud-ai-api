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

function normalizeText(value = '') {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
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

export function getPreviousReadQueryState(history = []) {
  const items = Array.isArray(history) ? history : []

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.role !== 'assistant') continue
    const data = getHistoryData(item)
    if (data?.type !== 'read-query-result' || !data?.plan?.entity) continue

    return {
      plan: data.plan,
      entity: data.entity,
      total: Number(data.total || 0),
      shown: Number(data.shown || 0),
      offset: Number(data.offset || 0),
      limit: Number(data.limit || data.plan.limit || DEFAULT_READ_QUERY_LIMIT),
      hasMore: data.hasMore === true,
      nextOffset: Number(data.nextOffset ?? data.offset + data.shown),
      previousOffset: Number(data.previousOffset ?? Math.max(data.offset - data.limit, 0)),
    }
  }

  return null
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
  if (/\b(quanti|quante|quanto|numero|totale|conta|conteggio)\b/i.test(text)) return 'count'
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
    if (year) filters.push({field: 'expiryYears', operator: 'contains', value: year})
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

function buildDeterministicPlan(message = '', previousState = null) {
  const text = normalizeText(message)
  if (!text) return null

  const pagination = parsePagination(message, previousState)
  if (pagination) return pagination

  const entity = detectPrimaryEntity(text)
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

function shouldUseSemanticPlanner(message = '', previousState = null) {
  const text = normalizeText(message)
  if (!text) return false

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
    fields: Object.keys(definition.fields || {}),
  }))

  const systemPrompt = [
    'Sei il planner strutturato di sola lettura del modulo rinnovi Webcloud.',
    'Non rispondere all’utente e non accedere a database o API.',
    'Trasforma la richiesta in un piano JSON usando esclusivamente entità, campi e operatori consentiti.',
    'Le action, le conferme, gli annullamenti e le diagnostiche sono gestiti prima di questo planner.',
    'Non inventare nomi, filtri o valori non presenti nella richiesta.',
    'Se la richiesta è un seguito, modifica il previousPlan senza perdere i filtri non sostituiti.',
    'Per richieste sui servizi puoi usare entity=services, ma il backend può delegarle al planner storico.',
    'Operatori consentiti: equals, not-equals, contains, not-contains, in, between, gte, lte, exists, not-exists, truthy, falsey.',
    'Restituisci esclusivamente JSON valido senza markdown.',
  ].join(' ')

  const payload = {
    request: String(message || '').trim(),
    previousPlan: previousState?.plan || null,
    entities: registrySummary,
    outputSchema: {
      operation: 'list | count | detail',
      entity: 'entity id',
      filters: [{field: 'allowed field', operator: 'allowed operator', value: 'scalar | array | {start,end}'}],
      sort: [{field: 'allowed field', direction: 'asc | desc'}],
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
} = {}) {
  const previousState = getPreviousReadQueryState(history)
  const registry = getReadEntityRegistry()
  const deterministic = buildDeterministicPlan(message, previousState)

  if (deterministic) {
    const validation = validateReadQueryPlan(deterministic, registry)
    if (validation.ok) return validation.plan
  }

  if (!allowSemantic || !shouldUseSemanticPlanner(message, previousState)) {
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
    if (validation.plan.entity === 'services') return null

    return validation.plan
  } catch {
    return null
  }
}
