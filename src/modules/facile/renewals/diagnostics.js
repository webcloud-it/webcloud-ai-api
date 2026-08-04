import {createHash} from 'node:crypto'

import {normalizeSearchText} from '../../../utils/text.js'
import {buildServiceListPayload} from './serviceQueries.js'
import {parseServiceListSelector, resolveServiceListReference} from './serviceListReferences.js'
import {pickPreviousServiceListState} from './serviceListState.js'
import {checkServiceHttpResponse, getPleskRenewalsAudit} from './service.js'

const TOOL_ID = 'renewals.check-service-http-response'
const SUBSCRIPTION_EXPIRY_TOOL_ID = 'renewals.read-subscription-expiry'
const PLESK_AUDIT_TOOL_ID = 'renewals.audit-plesk-renewals'
const DIAGNOSTIC_CONTEXT_TTL_MS = 30 * 60 * 1000
const recentDiagnosticTargets = new Map()
const pendingDiagnosticClarifications = new Map()

const HTTP_CHECK_VERB_PATTERN =
  /\b(?:controlla|controllare|verifica|verificare|testa|testare|prova|provare|accertati|accertare|vedi|dimmi)\b/i

const HTTP_CHECK_TERM_PATTERN =
  /\b(?:sito|website|dominio|url|https?|rispond(?:e|a|ono)|raggiungibile|online|status|stato\s+http|codice\s+http)\b/i

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/i
const DOMAIN_PATTERN =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\b/i


const PLESK_AUDIT_REQUEST_PATTERN =
  /\b(?:audit|controlla|controllare|verifica|verificare|analizza|analizzare|mostra|mostrare|elenca|elencare|trova|trovare|cerca|cercare|problemi|anomalie|errori|incoerenze|stato)\b/i

const PLESK_AUDIT_STRONG_FILTER_PATTERN =
  /\b(?:scadenz[ae][\s\S]{0,50}(?:divers[ae]|discordant[ei]|non\s+corrispond)|pian[oi][\s\S]{0,50}(?:divers[oi]|non\s+corrispond)|(?:subscription|sottoscrizion[ei])[\s\S]{0,40}(?:non\s+trovat[ae]|mancant[ei]|bloccata|non\s+sincronizzata)|domini?[\s\S]{0,40}non\s+collegat[oi]|guid[\s\S]{0,30}mancant[ei]|(?:le\s+)?non\s+sincronizzat[ae])\b/i

const PLESK_AUDIT_CODES = new Set([
  'missing_plesk_integration_id',
  'plesk_domain_not_linked',
  'plesk_subscription_not_found',
  'expiration_mismatch',
  'base_plan_mismatch',
  'plesk_subscription_not_synced',
  'plesk_subscription_locked',
])

function fingerprintToken(token = '') {
  return createHash('sha256')
    .update(String(token || ''))
    .digest('hex')
    .slice(0, 24)
}

function cleanupRecentDiagnosticTargets(now = Date.now()) {
  for (const [actorFingerprint, context] of recentDiagnosticTargets.entries()) {
    if (!context || context.expiresAt <= now) {
      recentDiagnosticTargets.delete(actorFingerprint)
    }
  }
}

function cleanupPendingDiagnosticClarifications(now = Date.now()) {
  for (const [actorFingerprint, pending] of pendingDiagnosticClarifications.entries()) {
    if (!pending || pending.expiresAt <= now) {
      pendingDiagnosticClarifications.delete(actorFingerprint)
    }
  }
}

function rememberDiagnosticTarget(actorToken = '', target = null) {
  if (!target?.id) return

  recentDiagnosticTargets.set(fingerprintToken(actorToken), {
    target: {
      type: 'service',
      id: String(target.id),
      label: target.label || String(target.id),
    },
    expiresAt: Date.now() + DIAGNOSTIC_CONTEXT_TTL_MS,
  })
}

function getRecentDiagnosticTarget(actorToken = '') {
  cleanupRecentDiagnosticTargets()

  return recentDiagnosticTargets.get(fingerprintToken(actorToken))?.target || null
}

function normalizeProtocol(message = '') {
  const text = String(message || '')
  const explicitUrl = text.match(URL_PATTERN)?.[0] || ''

  if (/^https:\/\//i.test(explicitUrl) || /\bhttps\b/i.test(text)) {
    return 'https'
  }

  if (/^http:\/\//i.test(explicitUrl) || /\bhttp\b/i.test(text)) {
    return 'http'
  }

  return 'auto'
}

function stripUrlParts(value = '') {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/[.,!?;:]+$/g, '')
    .trim()
}

function cleanNamedTarget(value = '') {
  const cleaned = String(value || '')
    .replace(/^[\s:,-]+|[\s?.!,;:,-]+$/g, '')
    .replace(/^(?:il|lo|la|i|gli|le|un|una)\s+/i, '')
    .replace(/^(?:servizio|sito|dominio|website|url)\s+/i, '')
    .replace(/^(?:di|del|della|per|su)\s+/i, '')
    .trim()

  if (
    /^(?:anche|ora|adesso|poi|di nuovo|nuovamente|lo stesso|la stessa|questo|questa|quello|quella)$/i.test(
      cleaned
    )
  ) {
    return null
  }

  return cleaned || null
}

function extractNamedTarget(message = '') {
  const text = String(message || '').trim()
  const quoted = text.match(/["“”']([^"“”']{2,})["“”']/)

  if (quoted?.[1]) {
    return cleanNamedTarget(quoted[1])
  }

  const url = text.match(URL_PATTERN)?.[0]

  if (url) {
    return stripUrlParts(url)
  }

  const domain = text.match(DOMAIN_PATTERN)?.[0]

  if (domain) {
    return stripUrlParts(domain)
  }

  const patterns = [
    /\b(?:sito|website|dominio|url)\s+(?:di|del|della|per|su)?\s*(.+?)(?=\s+(?:rispond(?:e|a)|funziona|è\s+online|e\s+online|raggiungibile|in\s+https?|con\s+https?|via\s+https?)\b|$)/i,
    /\b(?:controlla|verifica|testa|prova)\s+(?:se\s+)?(?:il\s+|lo\s+|la\s+)?(?:sito\s+|website\s+|dominio\s+|url\s+)?(?:di\s+|del\s+|della\s+|per\s+)?(.+?)(?=\s+(?:rispond(?:e|a)|funziona|è\s+online|e\s+online|raggiungibile|in\s+https?|con\s+https?|via\s+https?)\b|$)/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    const target = cleanNamedTarget(match?.[1])

    if (target) {
      return target
    }
  }

  return null
}


const SUBSCRIPTION_EXPIRY_TERM_PATTERN =
  /\b(?:scadenz[ae]|scade|scadono|scadr[aà]|data\s+di\s+scadenza)\b/i

const SUBSCRIPTION_EXPIRY_FOLLOW_UP_PATTERN =
  /\b(?:quella|quello|la\s+stessa|lo\s+stesso)\b[\s\S]{0,30}\b(?:cliente|fornitore|supplier|provider)\b/i

const SUBSCRIPTION_EXPIRY_MUTATION_PATTERN =
  /\b(?:imposta|impostare|modifica|modificare|cambia|cambiare|aggiorna|aggiornare|sposta|spostare|posticipa|anticipa|rimuovi|rimuovere|togli|togliere|cancella|cancellare|azzera)\b/i

export function parseServiceHttpCheckRequest(message = '') {
  const text = String(message || '').trim()
  const normalized = normalizeSearchText(text)

  if (!normalized) return null

  const hasVerb = HTTP_CHECK_VERB_PATTERN.test(normalized)
  const hasTerm = HTTP_CHECK_TERM_PATTERN.test(normalized)
  const asksWhetherItResponds =
    /\b(?:sito|website|dominio|url)\b[\s\S]{0,80}\b(?:rispond(?:e|a)|funziona|raggiungibile|online)\b/i.test(
      normalized
    )

  if (!(hasVerb && hasTerm) && !asksWhetherItResponds) {
    return null
  }

  const selector = parseServiceListSelector(text)
  const namedTarget = selector ? null : extractNamedTarget(text)

  return {
    type: 'renewals-http-check-request',
    tool: TOOL_ID,
    message: text,
    protocol: normalizeProtocol(text),
    selector,
    selectorSource: selector ? 'previous-list' : namedTarget ? 'named-target' : 'context',
    namedTarget,
  }
}


function parseSubscriptionExpiryKind(message = '') {
  const normalized = normalizeSearchText(message)

  if (/\b(?:fornitore|supplier|provider)\b/i.test(normalized)) {
    return 'supplier'
  }

  if (/\bcliente\b/i.test(normalized)) {
    return 'customer'
  }

  return 'all'
}

function extractSubscriptionExpiryNamedTarget(message = '') {
  const text = String(message || '').trim()
  const quoted = text.match(/["“”']([^"“”']{2,})["“”']/)

  if (quoted?.[1]) {
    return cleanNamedTarget(quoted[1])
  }

  const url = text.match(URL_PATTERN)?.[0]
  if (url) return stripUrlParts(url)

  const domain = text.match(DOMAIN_PATTERN)?.[0]
  if (domain) return stripUrlParts(domain)

  const patterns = [
    /\b(?:qual\s*[eè']?|che)\s+(?:la\s+)?(?:data\s+di\s+)?scadenz[ae](?:\s+(?:cliente|fornitore|supplier|provider))?\s+(?:di|del|della|per)\s+(.+)$/i,
    /\b(?:quando\s+scade|scade|scadenza|data\s+di\s+scadenza)(?:\s+(?:cliente|fornitore|supplier|provider))?\s+(?:di|del|della|per)?\s*(.+)$/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    const target = cleanNamedTarget(match?.[1])

    if (target) return target
  }

  return null
}

function isSubscriptionExpiryListRequest(message = '') {
  const normalized = normalizeSearchText(message)

  if (!normalized) return false

  const hasPluralEntity =
    /\b(?:servizi|domini|abbonamenti|sottoscrizioni|rinnovi)\b/i.test(normalized)
  const hasListVerb =
    /\b(?:tutti|tutte|quali|elenca|elencami|mostra|mostrami|lista|elenco|trova|cerca)\b/i.test(
      normalized
    )
  const hasPluralExpiry = /\b(?:scadono|scadranno|scaduti|scadute)\b/i.test(normalized)
  const hasRangeOrOperationalWindow =
    /\b(?:nel|nell['’]?anno|entro|tra|fra|dal|dall['’]?|al|fino al)\s+(?:20\d{2}|\d{1,2}[/-]\d{1,2}[/-]20\d{2})\b/i.test(
      normalized
    ) ||
    /\b(?:in scadenza|scadenza imminente|scadenze imminenti|rinnovi imminenti)\b/i.test(
      normalized
    )

  return (
    (hasPluralEntity && (hasListVerb || hasPluralExpiry || hasRangeOrOperationalWindow)) ||
    (hasListVerb && (hasPluralExpiry || hasRangeOrOperationalWindow))
  )
}

function isContextualSingleSubscriptionExpiryRequest(message = '') {
  const normalized = normalizeSearchText(message)

  return (
    /\b(?:questo|questa|quello|quella|quel servizio|questo servizio|quel dominio|questo dominio|lo stesso|la stessa)\b/i.test(
      normalized
    ) ||
    /^\s*(?:e\s+)?(?:quando\s+scade|qual\s*[eè']?\s+la\s+scadenza|scadenza)(?:\s+(?:cliente|fornitore|supplier|provider))?\s*[?.!]*$/i.test(
      normalized
    )
  )
}

export function parseServiceSubscriptionExpiryRequest(message = '') {
  const text = String(message || '').trim()
  const normalized = normalizeSearchText(text)

  if (!normalized || SUBSCRIPTION_EXPIRY_MUTATION_PATTERN.test(normalized)) {
    return null
  }

  /*
   * Questa diagnostica riguarda una singola sottoscrizione. Le richieste plurali
   * o globali devono proseguire verso il planner delle liste, che gestisce filtri,
   * intervalli temporali e paginazione.
   */
  if (isSubscriptionExpiryListRequest(normalized)) {
    return null
  }

  const hasExpiryTerm = SUBSCRIPTION_EXPIRY_TERM_PATTERN.test(normalized)
  const isFollowUp = SUBSCRIPTION_EXPIRY_FOLLOW_UP_PATTERN.test(normalized)

  if (!hasExpiryTerm && !isFollowUp) {
    return null
  }

  const selector = parseServiceListSelector(text)
  const namedTarget = selector ? null : extractSubscriptionExpiryNamedTarget(text)
  const contextualTarget =
    !selector && !namedTarget && (isFollowUp || isContextualSingleSubscriptionExpiryRequest(text))

  if (!selector && !namedTarget && !contextualTarget) {
    return null
  }

  return {
    type: 'renewals-subscription-expiry-request',
    tool: SUBSCRIPTION_EXPIRY_TOOL_ID,
    message: text,
    subscriptionKind: parseSubscriptionExpiryKind(text),
    selector,
    selectorSource: selector ? 'previous-list' : namedTarget ? 'named-target' : 'context',
    namedTarget,
  }
}


function parsePleskAuditFilters(message = '') {
  const normalized = normalizeSearchText(message)
  const codes = []
  const severities = []

  if (/\b(?:scadenz[ae]|expiration)[\s\S]{0,60}(?:divers[ae]|discordant[ei]|mismatch|non\s+corrispond)/i.test(normalized)) {
    codes.push('expiration_mismatch')
  }

  if (/\b(?:pian[oi]\s+base|pian[oi])[\s\S]{0,60}(?:divers[oi]|discordant[ei]|mismatch|non\s+corrispond)/i.test(normalized)) {
    codes.push('base_plan_mismatch')
  }

  if (/\b(?:non\s+sincronizzat[ae]|fuori\s+sincronizzazione|piano\s+non\s+sincronizzato)\b/i.test(normalized)) {
    codes.push('plesk_subscription_not_synced')
  }

  if (/\b(?:subscription|sottoscrizion[ei])?[\s\S]{0,30}\bbloccata\b/i.test(normalized)) {
    codes.push('plesk_subscription_locked')
  }

  if (/\b(?:domini?|collegamenti?)[\s\S]{0,50}\bnon\s+collegat[oi]\b/i.test(normalized)) {
    codes.push('plesk_domain_not_linked')
  }

  if (/\b(?:subscription|sottoscrizion[ei])[\s\S]{0,50}(?:non\s+trovat[ae]|mancant[ei]|inesistent[ei])\b/i.test(normalized)) {
    codes.push('plesk_subscription_not_found')
  }

  if (/\bguid[\s\S]{0,40}(?:mancant[ei]|assent[ei]|non\s+presente)\b/i.test(normalized)) {
    codes.push('missing_plesk_integration_id')
  }

  if (/\b(?:solo\s+)?(?:errori|error|criticit[aà]\s+gravi)\b/i.test(normalized)) {
    severities.push('error')
  }

  if (/\b(?:solo\s+)?(?:avvisi|warning|segnalazioni)\b/i.test(normalized)) {
    severities.push('warning')
  }

  return {
    codes: [...new Set(codes)],
    severities: [...new Set(severities)],
  }
}

function extractPleskAuditNamedTarget(message = '') {
  const text = String(message || '').trim()
  const quoted = text.match(/["“”']([^"“”']{2,})["“”']/)

  if (quoted?.[1]) {
    const target = cleanNamedTarget(quoted[1])

    if (target && !/\b(?:plesk|audit|anomali|problemi|errori|avvisi|scadenz|pian[oi]|subscription|guid)\b/i.test(target)) {
      return target
    }
  }

  const url = text.match(URL_PATTERN)?.[0]
  if (url) return stripUrlParts(url)

  const domain = text.match(DOMAIN_PATTERN)?.[0]
  if (domain) return stripUrlParts(domain)

  const patterns = [
    /\b(?:per|sul|su|del|della|di)\s+(?:(?:il|lo|la|un|una)\s+)?(?:servizio|dominio|sito)?\s*(.+?)(?=\s+(?:mostrando|limitando|solo\s+gli|solo\s+le|con\s+codice)\b|$)/i,
    /\b(?:audit|controlla|verifica|analizza)\s+(?:plesk\s+)?(?:per\s+)?(?:(?:il|lo|la)\s+)?(?:servizio|dominio|sito)\s+(.+)$/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    const target = cleanNamedTarget(match?.[1])

    if (
      target &&
      !/^(?:plesk|generale|globale|complessivo|tutto|tutti)$/i.test(target) &&
      !/\b(?:anomali|problemi|errori|avvisi|warning|scadenz|pian[oi]|subscription|sottoscrizion|guid|non\s+sincronizzat|bloccata)\b/i.test(target)
    ) {
      return target
    }
  }

  return null
}

export function parsePleskAuditRequest(message = '') {
  const text = String(message || '').trim()
  const normalized = normalizeSearchText(text)

  if (!normalized) return null

  const hasPlesk = /\bplesk\b/i.test(normalized)
  const hasAuditRequest = PLESK_AUDIT_REQUEST_PATTERN.test(normalized)
  const hasStrongFilter = PLESK_AUDIT_STRONG_FILTER_PATTERN.test(normalized)

  if (!(hasPlesk && hasAuditRequest) && !hasStrongFilter) {
    return null
  }

  const selector = parseServiceListSelector(text)
  const namedTarget = selector ? null : extractPleskAuditNamedTarget(text)
  const filters = parsePleskAuditFilters(text)
  const contextualTarget =
    !selector &&
    !namedTarget &&
    /\b(?:questo|questa|quello|quella|quel\s+servizio|questo\s+servizio|quel\s+dominio|questo\s+dominio|lo\s+stesso|la\s+stessa|ora|adesso)\b/i.test(normalized)

  return {
    type: 'renewals-plesk-audit-request',
    tool: PLESK_AUDIT_TOOL_ID,
    message: text,
    filters,
    selector,
    selectorSource: selector
      ? 'previous-list'
      : namedTarget
        ? 'named-target'
        : contextualTarget
          ? 'context'
          : 'all',
    namedTarget,
  }
}

function applyScope(services = [], {customerId = null, groupId = null, serviceId = null} = {}) {
  return services.filter(service => {
    if (serviceId && String(service?.id) !== String(serviceId)) return false
    if (customerId && String(service?.customer?.id) !== String(customerId)) return false
    if (groupId && String(service?.customer?.group?.id) !== String(groupId)) return false

    return true
  })
}

function toReferenceItem(service = {}) {
  return {
    id: service?.id || null,
    ids: service?.id ? [service.id] : [],
    servizio: service?.name || null,
    dominio: service?.domains_id?.name || service?.domain?.name || null,
    cliente: service?.customer?.name || null,
    customerId: service?.customer?.id || null,
    gruppo: service?.customer?.group?.name || null,
    groupId: service?.customer?.group?.id || null,
  }
}

function uniqueServiceIds(item = {}) {
  return [...new Set([...(item?.ids || []), item?.id].filter(Boolean).map(String))]
}

function buildCurrentPreviousListItems({previousState, services, settings, scope}) {
  if (Array.isArray(previousState?.data?.items)) {
    return previousState.data.items
  }

  if (!previousState?.query?.filters?.length) {
    return []
  }

  return buildServiceListPayload({
    services,
    settings,
    message: previousState.sourceMessage || previousState.query.sourceMessage || '',
    previousQuery: previousState.query,
    pagination: {
      direction: 'current',
      limit: previousState.limit || previousState.query.limit || 20,
      offset: previousState.offset || previousState.query.offset || 0,
    },
    includeDontRenewOverride:
      typeof previousState.query.includeDontRenew === 'boolean'
        ? previousState.query.includeDontRenew
        : null,
    customerId: scope.customerId,
    groupId: scope.groupId,
    serviceId: scope.serviceId,
  }).items
}

function resolveFromPreviousList({request, services, settings, history, scope}) {
  const previousState = pickPreviousServiceListState(
    history,
    {
      customerId: scope.customerId,
      groupId: scope.groupId,
      serviceId: null,
    },
    settings,
    request.message || ''
  )

  if (!previousState) {
    return {
      status: 'missing-list',
    }
  }

  const items = buildCurrentPreviousListItems({
    previousState,
    services,
    settings,
    scope: {
      ...scope,
      serviceId: null,
    },
  })

  return resolveServiceListReference({
    request: {
      selector: request.selector,
    },
    items,
  })
}

function getStoredServiceDomain(service = {}) {
  const candidates = [service?.domains_id?.name, service?.domain?.name, service?.domain]

  for (const candidate of candidates) {
    if (!candidate || typeof candidate === 'object') continue

    const hostname = stripUrlParts(candidate).toLowerCase()
    const matchedDomain = hostname.match(DOMAIN_PATTERN)?.[0]?.toLowerCase() || null

    if (matchedDomain && matchedDomain === hostname) {
      return matchedDomain
    }
  }

  return null
}

function resolveNamedTarget({request, services, scope}) {
  const scoped = applyScope(services, {
    customerId: scope.customerId,
    groupId: scope.groupId,
    serviceId: null,
  })
  const namedTarget = String(request.namedTarget || '').trim()
  const directIdMatch = scoped.find(service => String(service?.id) === namedTarget)

  if (directIdMatch) {
    return {
      status: 'resolved',
      item: toReferenceItem(directIdMatch),
    }
  }

  const normalizedDomain = stripUrlParts(namedTarget).toLowerCase()
  const isExactDomainQuery = DOMAIN_PATTERN.test(normalizedDomain)

  if (isExactDomainQuery) {
    const exactDomainMatches = scoped.filter(
      service => getStoredServiceDomain(service) === normalizedDomain
    )

    if (exactDomainMatches.length === 1) {
      return {
        status: 'resolved',
        item: toReferenceItem(exactDomainMatches[0]),
      }
    }

    if (exactDomainMatches.length > 1) {
      return resolveServiceListReference({
        request: {
          selector: {
            kind: 'text',
            term: namedTarget,
          },
        },
        items: exactDomainMatches.map(toReferenceItem),
      })
    }
  }

  return resolveServiceListReference({
    request: {
      selector: {
        kind: 'text',
        term: namedTarget,
      },
    },
    items: scoped.map(toReferenceItem),
  })
}

function resolveContextTarget({services, scope, actorToken, recentServiceId = null}) {
  const recentDiagnosticTarget = getRecentDiagnosticTarget(actorToken)
  const serviceId = scope.serviceId || recentDiagnosticTarget?.id || recentServiceId || null

  if (!serviceId) {
    return {
      status: 'missing-target',
    }
  }

  const service = applyScope(services, {
    ...scope,
    serviceId,
  })[0]

  return service
    ? {
        status: 'resolved',
        item: toReferenceItem(service),
      }
    : {
        status: 'not-found',
        term: serviceId,
      }
}

function getPrimaryPlanName(service = {}) {
  return (
    (service?.subscriptions || [])
      .filter(subscription => subscription?.isSupplier !== true && subscription?.plan?.name)
      .map(subscription => subscription.plan.name)[0] || null
  )
}

function getSupplierNames(service = {}) {
  return [
    ...new Set(
      (service?.subscriptions || [])
        .filter(subscription => subscription?.isSupplier === true)
        .map(subscription => subscription?.plan?.supplier?.name)
        .filter(Boolean)
    ),
  ]
}

function buildResolutionClarification(resolution = {}, services = []) {
  if (resolution.status === 'missing-list') {
    return 'Non ho una lista precedente da cui selezionare il servizio. Chiedimi prima quali servizi vuoi vedere.'
  }

  if (resolution.status === 'missing-target') {
    return 'Indica quale servizio o dominio vuoi controllare, usando il nome oppure un riferimento alla lista precedente.'
  }

  if (resolution.status === 'empty-list') {
    return 'La lista precedente non contiene servizi selezionabili.'
  }

  if (resolution.status === 'out-of-range') {
    return `La pagina corrente contiene ${
      resolution.available || 0
    } servizi. Indica una posizione compresa tra 1 e ${resolution.available || 0}.`
  }

  if (resolution.status === 'not-found') {
    return `Non ho trovato un servizio corrispondente a "${
      resolution.term || ''
    }". Indica un nome più preciso.`
  }

  if (resolution.status === 'ambiguous') {
    const rows = (resolution.candidates || []).slice(0, 8).map((candidate, index) => {
      const ids = uniqueServiceIds(candidate.item || {})
      const service = services.find(item => ids.includes(String(item?.id)))
      const domain = service?.domains_id?.name || service?.domain?.name || null

      return [
        `${index + 1}. ${service?.name || domain || 'Servizio'} (ID ${service?.id || '—'})`,
        `   Dominio: ${domain || '—'}`,
        `   Cliente: ${service?.customer?.name || '—'}`,
        `   Gruppo: ${service?.customer?.group?.name || '—'}`,
        `   Piano: ${getPrimaryPlanName(service) || '—'}`,
        `   Fornitore: ${getSupplierNames(service).join(', ') || '—'}`,
      ].join('\n')
    })

    return [
      `Ho trovato più servizi corrispondenti a "${resolution.term || ''}".`,
      'Quale dominio vuoi controllare?',
      '',
      ...rows,
      '',
      'Rispondi con il numero, con l’ID oppure con un dettaglio distintivo.',
    ].join('\n')
  }

  return 'Non sono riuscito a identificare un solo servizio. Indica il nome esatto o il numero della riga.'
}

function findResolvedService(services = [], item = {}) {
  const ids = uniqueServiceIds(item)

  if (ids.length !== 1) {
    return {
      status: ids.length > 1 ? 'grouped-row' : 'not-found',
      ids,
    }
  }

  const service = services.find(candidate => String(candidate?.id) === ids[0])

  return service
    ? {
        status: 'resolved',
        service,
      }
    : {
        status: 'not-found',
        ids,
      }
}

function getServiceLabel(service = {}) {
  return (
    service?.name ||
    service?.domains_id?.name ||
    service?.domain?.name ||
    String(service?.id || 'Servizio')
  )
}

function joinItalian(items = []) {
  if (!items.length) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} e ${items[1]}`

  return `${items.slice(0, -1).join(', ')} e ${items.at(-1)}`
}

function getServiceDomain(service = {}) {
  const candidates = [
    service?.domains_id?.name,
    service?.domain?.name,
    service?.domain,
    service?.name,
  ]

  for (const candidate of candidates) {
    const hostname = stripUrlParts(candidate)
    const matchedDomain = hostname.match(DOMAIN_PATTERN)?.[0] || null

    if (matchedDomain) {
      return matchedDomain.toLowerCase()
    }
  }

  return null
}


function normalizeComparable(value = '') {
  return normalizeSearchText(value)
    .replace(/[^a-z0-9à-ÿ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractOrdinalIndex(message = '') {
  const text = normalizeComparable(message)
  const numeric = text.match(/^\s*(\d+)\s*$/)

  if (numeric) {
    return Number(numeric[1]) - 1
  }

  const ordinals = [
    ['primo', 'prima'],
    ['secondo', 'seconda'],
    ['terzo', 'terza'],
    ['quarto', 'quarta'],
    ['quinto', 'quinta'],
    ['sesto', 'sesta'],
    ['settimo', 'settima'],
    ['ottavo', 'ottava'],
  ]

  return ordinals.findIndex(words =>
    words.some(word => new RegExp(`\\b${word}\\b`, 'i').test(text))
  )
}

function buildCandidateSearchText(service = {}) {
  return normalizeComparable(
    [
      service?.id,
      service?.name,
      service?.domains_id?.name,
      service?.domain?.name,
      service?.customer?.name,
      service?.customer?.group?.name,
      getPrimaryPlanName(service),
      ...getSupplierNames(service),
    ]
      .filter(Boolean)
      .join(' ')
  )
}

function rememberPendingDiagnosticClarification({
  request,
  resolution,
  services,
  scope,
  actorToken,
  recentServiceId = null,
}) {
  const candidateIds = (resolution?.candidates || [])
    .flatMap(candidate => uniqueServiceIds(candidate?.item || {}))
    .filter(id => services.some(service => String(service?.id) === String(id)))

  if (!candidateIds.length) return

  pendingDiagnosticClarifications.set(fingerprintToken(actorToken), {
    request,
    scope,
    recentServiceId,
    candidateIds: [...new Set(candidateIds.map(String))],
    createdAt: Date.now(),
    expiresAt: Date.now() + DIAGNOSTIC_CONTEXT_TTL_MS,
  })
}

function resolvePendingDiagnosticCandidate(message = '', services = [], candidateIds = []) {
  const candidates = candidateIds
    .map(id => services.find(service => String(service?.id) === String(id)))
    .filter(Boolean)

  if (!candidates.length) {
    return {
      status: 'not-found',
    }
  }

  const raw = String(message || '').trim()
  const ordinalIndex = extractOrdinalIndex(raw)

  if (ordinalIndex >= 0 && ordinalIndex < candidates.length) {
    return {
      status: 'resolved',
      service: candidates[ordinalIndex],
    }
  }

  const exactId = candidates.find(service => String(service?.id) === raw)

  if (exactId) {
    return {
      status: 'resolved',
      service: exactId,
    }
  }

  const normalized = normalizeComparable(raw)
  const searchable = normalized
    .replace(
      /\b(quello|quella|servizio|sito|dominio|con|il|lo|la|l|fornitore|piano|cliente|gruppo|che|ha)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()

  if (!searchable) {
    return {
      status: 'unrecognized',
    }
  }

  const matched = candidates.filter(service =>
    buildCandidateSearchText(service).includes(searchable)
  )

  if (matched.length === 1) {
    return {
      status: 'resolved',
      service: matched[0],
    }
  }

  if (matched.length > 1) {
    return {
      status: 'ambiguous',
      candidates: matched,
    }
  }

  return {
    status: 'not-found',
  }
}

export function hasPendingRenewalsDiagnosticClarification({actorToken = ''} = {}) {
  cleanupPendingDiagnosticClarifications()

  return pendingDiagnosticClarifications.has(fingerprintToken(actorToken))
}

export async function handlePendingRenewalsDiagnosticClarification({
  message = '',
  services = [],
  settings = {},
  history = [],
  scope = {},
  actorToken = '',
  recentServiceId = null,
} = {}) {
  cleanupPendingDiagnosticClarifications()

  const actorFingerprint = fingerprintToken(actorToken)
  const pending = pendingDiagnosticClarifications.get(actorFingerprint)

  if (!pending) return null

  const selection = resolvePendingDiagnosticCandidate(
    message,
    services,
    pending.candidateIds || []
  )

  if (selection.status === 'unrecognized') {
    return null
  }

  if (selection.status !== 'resolved') {
    const candidateServices = (pending.candidateIds || [])
      .map(id => services.find(service => String(service?.id) === String(id)))
      .filter(Boolean)
    const isPleskAudit = pending.request?.type === 'renewals-plesk-audit-request'
    const isSubscriptionExpiry =
      pending.request?.type === 'renewals-subscription-expiry-request'
    const reasonPrefix = isPleskAudit
      ? 'plesk-audit-target'
      : isSubscriptionExpiry
        ? 'subscription-expiry-target'
        : 'http-check-target'
    const tool = isPleskAudit
      ? PLESK_AUDIT_TOOL_ID
      : isSubscriptionExpiry
        ? SUBSCRIPTION_EXPIRY_TOOL_ID
        : TOOL_ID

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: [
        selection.status === 'ambiguous'
          ? 'Il dettaglio indicato corrisponde ancora a più servizi.'
          : 'Non riesco a collegare la risposta a uno dei servizi proposti.',
        'Indica il numero, l’ID, il dominio, il cliente, il piano oppure il fornitore:',
        '',
        ...candidateServices.map((service, index) => {
          const domain = service?.domains_id?.name || service?.domain?.name || '—'

          return `${index + 1}. ${service?.name || domain} (ID ${service?.id}) — ${domain} — ${
            service?.customer?.name || 'cliente —'
          } — ${getPrimaryPlanName(service) || 'piano —'}`
        }),
      ].join('\n'),
      data: {
        type: 'clarification',
        reason: `${reasonPrefix}-${selection.status || 'unresolved'}`,
      },
      meta: buildMeta('clarification', {
        tool,
        guard: `${reasonPrefix}-${selection.status || 'unresolved'}`,
      }),
    }
  }

  pendingDiagnosticClarifications.delete(actorFingerprint)

  const handler =
    pending.request?.type === 'renewals-plesk-audit-request'
      ? handlePleskAuditRequest
      : pending.request?.type === 'renewals-subscription-expiry-request'
        ? handleServiceSubscriptionExpiryRequest
        : handleServiceHttpCheckRequest

  return handler({
    request: {
      ...pending.request,
      selector: null,
      selectorSource: 'context',
      namedTarget: null,
    },
    services,
    settings,
    history,
    scope: {
      ...pending.scope,
      ...scope,
      serviceId: selection.service.id,
    },
    actorToken,
    recentServiceId: pending.recentServiceId || recentServiceId,
  })
}

function buildMeta(intent, extra = {}) {
  return {
    moduleId: 'facile.renewals',
    source: 'tool-fast',
    intent,
    tool: TOOL_ID,
    ...extra,
  }
}

function formatDiagnosticError(error = {}) {
  if (typeof error === 'string') return error

  return [error?.protocol, error?.status, error?.error || error?.message]
    .filter(value => value !== null && value !== undefined && value !== '')
    .join(': ')
}

function buildHttpCheckReply({domain, request, result}) {
  const protocol = String(result?.protocolTried || request.protocol || '')
    .replace(/^auto$/i, '')
    .toUpperCase()
  const status = result?.status != null ? `HTTP ${result.status}` : null
  const protocolText = protocol ? ` tramite ${protocol}` : ''

  const requestedProtocol = String(request.protocol || 'auto').toUpperCase()
  const protocolMismatch =
    requestedProtocol !== 'AUTO' && protocol && requestedProtocol !== protocol

  if (result?.ok === true) {
    const parts = [`Il sito "${domain}" risponde correttamente${protocolText}`]

    if (status) parts.push(`con stato ${status}`)
    if (result?.finalUrl) parts.push(`URL finale: ${result.finalUrl}`)
    if (protocolMismatch) {
      parts.push(
        `Il controllo applicativo ha usato ${protocol}: l'endpoint attuale non forza il solo ${requestedProtocol}`
      )
    }

    return `${parts.join('. ')}.`
  }

  const errors = (Array.isArray(result?.errors) ? result.errors : [])
    .map(formatDiagnosticError)
    .filter(Boolean)
    .slice(0, 4)

  const parts = [`Il sito "${domain}" non ha risposto correttamente${protocolText}`]

  if (status) parts.push(`stato ricevuto: ${status}`)
  if (result?.finalUrl) parts.push(`URL finale: ${result.finalUrl}`)
  if (errors.length) parts.push(`Dettagli: ${errors.join('; ')}`)
  if (protocolMismatch) {
    parts.push(
      `Il controllo applicativo ha usato ${protocol}: l'endpoint attuale non forza il solo ${requestedProtocol}`
    )
  }

  return `${parts.join('. ')}.`
}

export async function handleServiceHttpCheckRequest({
  request,
  services = [],
  settings = {},
  history = [],
  scope = {},
  actorToken = '',
  recentServiceId = null,
} = {}) {
  cleanupRecentDiagnosticTargets()
  cleanupPendingDiagnosticClarifications()
  pendingDiagnosticClarifications.delete(fingerprintToken(actorToken))

  const resolution =
    request.selectorSource === 'previous-list'
      ? resolveFromPreviousList({
          request,
          services,
          settings,
          history,
          scope,
        })
      : request.selectorSource === 'named-target'
        ? resolveNamedTarget({
            request,
            services,
            scope,
          })
        : resolveContextTarget({
            services,
            scope,
            actorToken,
            recentServiceId,
          })

  if (resolution.status !== 'resolved') {
    if (resolution.status === 'ambiguous') {
      rememberPendingDiagnosticClarification({
        request,
        resolution,
        services,
        scope,
        actorToken,
        recentServiceId,
      })
    }

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildResolutionClarification(resolution, services),
      data: {
        type: 'clarification',
        reason: `http-check-target-${resolution.status || 'unresolved'}`,
      },
      meta: buildMeta('clarification', {
        guard: `http-check-target-${resolution.status || 'unresolved'}`,
      }),
    }
  }

  const resolvedService = findResolvedService(services, resolution.item)

  if (resolvedService.status === 'grouped-row') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply:
        'La riga selezionata raggruppa più servizi. Indica il nome esatto del singolo dominio da controllare.',
      data: {
        type: 'clarification',
        reason: 'http-check-target-grouped-row',
        serviceIds: resolvedService.ids,
      },
      meta: buildMeta('clarification', {
        guard: 'http-check-target-grouped-row',
      }),
    }
  }

  if (resolvedService.status !== 'resolved') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: 'Il servizio selezionato non è più disponibile. Ripeti la ricerca prima di procedere.',
      data: {
        type: 'clarification',
        reason: 'http-check-target-not-found',
      },
      meta: buildMeta('clarification', {
        guard: 'http-check-target-not-found',
      }),
    }
  }

  const service = resolvedService.service
  const domain = getServiceDomain(service)
  const target = {
    type: 'service',
    id: String(service.id),
    label: service?.name || domain || String(service.id),
  }

  if (!domain) {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: `Il servizio "${target.label}" non contiene un dominio valido da sottoporre al controllo HTTP/HTTPS.`,
      data: {
        type: 'clarification',
        reason: 'http-check-domain-missing',
        target,
      },
      meta: buildMeta('clarification', {
        guard: 'http-check-domain-missing',
      }),
    }
  }

  rememberDiagnosticTarget(actorToken, target)

  try {
    const result = await checkServiceHttpResponse({
      domain,
      protocol: request.protocol || 'auto',
    })

    return {
      ok: true,
      intent: 'service-http-check',
      source: 'tool-fast',
      reply: buildHttpCheckReply({
        domain,
        request,
        result,
      }),
      data: {
        type: 'service-http-check',
        target,
        domain,
        requestedProtocol: request.protocol || 'auto',
        checked: result?.checked === true,
        reachable: result?.ok === true,
        status: result?.status ?? null,
        finalUrl: result?.finalUrl || null,
        protocolTried: result?.protocolTried || null,
        errors: Array.isArray(result?.errors) ? result.errors : [],
      },
      meta: buildMeta('service-http-check', {
        targetId: target.id,
        requestedProtocol: request.protocol || 'auto',
        protocolTried: result?.protocolTried || null,
      }),
    }
  } catch (error) {
    return {
      ok: false,
      intent: 'service-http-check',
      source: 'tool-fast',
      reply: `Non è stato possibile completare il controllo HTTP/HTTPS del dominio "${domain}".`,
      data: {
        type: 'service-http-check',
        target,
        domain,
        requestedProtocol: request.protocol || 'auto',
        checked: false,
        reachable: false,
        error: {
          code: 'http-check-failed',
          message: error?.message || String(error),
        },
      },
      meta: buildMeta('service-http-check', {
        targetId: target.id,
        errorCode: 'http-check-failed',
      }),
    }
  }
}


function normalizeSubscriptionDate(value) {
  if (!value) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  return date
}

function formatSubscriptionDate(value) {
  const date = normalizeSubscriptionDate(value)

  return date
    ? new Intl.DateTimeFormat('it-IT', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(date)
    : null
}

function deduplicateSubscriptions(items = []) {
  const seen = new Set()
  const out = []

  for (const item of items) {
    if (!item) continue

    const key = item?.id ? `id:${item.id}` : `ref:${out.length}`
    if (seen.has(key)) continue

    seen.add(key)
    out.push(item)
  }

  return out
}

function getServiceSubscriptionsByKind(service = {}, kind = 'all') {
  const directSubscriptions = Array.isArray(service?.subscriptions) ? service.subscriptions : []
  const customerSubscriptions = directSubscriptions.filter(item => item?.isSupplier !== true)
  const supplierSubscriptions = deduplicateSubscriptions([
    ...directSubscriptions.filter(item => item?.isSupplier === true),
    ...customerSubscriptions.flatMap(item =>
      Array.isArray(item?.suppliersSubscriptions) ? item.suppliersSubscriptions : []
    ),
  ])

  if (kind === 'customer') return customerSubscriptions
  if (kind === 'supplier') return supplierSubscriptions

  return [...customerSubscriptions, ...supplierSubscriptions]
}

function mapSubscriptionExpiryItem(subscription = {}, kind = 'customer') {
  return {
    id: subscription?.id || null,
    kind,
    startsOn: subscription?.startsOn || null,
    endsOn: subscription?.endsOn || null,
    plan: subscription?.plan?.name || subscription?.name || null,
    supplier: subscription?.plan?.supplier?.name || subscription?.supplier || null,
  }
}

function sortSubscriptionExpiryItems(items = []) {
  return [...items].sort((first, second) => {
    const firstDate = normalizeSubscriptionDate(first?.endsOn)?.getTime() ?? Number.MAX_SAFE_INTEGER
    const secondDate = normalizeSubscriptionDate(second?.endsOn)?.getTime() ?? Number.MAX_SAFE_INTEGER

    return firstDate - secondDate
  })
}

function formatSubscriptionExpiryLine(item = {}, {includeKind = false} = {}) {
  const kindLabel = item.kind === 'supplier' ? 'Fornitore' : 'Cliente'
  const date = formatSubscriptionDate(item.endsOn) || 'data non impostata'
  const details = [item.plan ? `piano ${item.plan}` : null, item.supplier ? `fornitore ${item.supplier}` : null]
    .filter(Boolean)
    .join(', ')

  return `${includeKind ? `${kindLabel}: ` : ''}${date}${details ? ` (${details})` : ''}`
}

function buildSubscriptionExpiryReply({service, subscriptionKind, items}) {
  const serviceLabel = getServiceLabel(service)

  if (subscriptionKind === 'all') {
    const customerItems = items.filter(item => item.kind === 'customer')
    const supplierItems = items.filter(item => item.kind === 'supplier')

    if (!items.length) {
      return `Non risultano sottoscrizioni cliente o fornitore per "${serviceLabel}".`
    }

    const lines = [
      `Scadenze di "${serviceLabel}":`,
      ...customerItems.map(item => `- ${formatSubscriptionExpiryLine(item, {includeKind: true})}`),
      ...supplierItems.map(item => `- ${formatSubscriptionExpiryLine(item, {includeKind: true})}`),
    ]

    if (!customerItems.length) lines.push('- Cliente: nessuna sottoscrizione trovata')
    if (!supplierItems.length) lines.push('- Fornitore: nessuna sottoscrizione trovata')

    return lines.join('\n')
  }

  const kindLabel = subscriptionKind === 'supplier' ? 'fornitore' : 'cliente'

  if (!items.length) {
    return `Non risulta una sottoscrizione ${kindLabel} per "${serviceLabel}".`
  }

  if (items.length === 1) {
    const item = items[0]
    const date = formatSubscriptionDate(item.endsOn)
    const details = [item.plan ? `piano ${item.plan}` : null, item.supplier ? `fornitore ${item.supplier}` : null]
      .filter(Boolean)
      .join(', ')

    if (!date) {
      return `La sottoscrizione ${kindLabel} di "${serviceLabel}" non ha una data di scadenza impostata${
        details ? ` (${details})` : ''
      }.`
    }

    return `La scadenza ${kindLabel} di "${serviceLabel}" è il ${date}${
      details ? ` (${details})` : ''
    }.`
  }

  return [
    `Per "${serviceLabel}" risultano ${items.length} sottoscrizioni ${kindLabel}:`,
    ...items.map((item, index) => `${index + 1}. ${formatSubscriptionExpiryLine(item)}`),
  ].join('\n')
}

export async function handleServiceSubscriptionExpiryRequest({
  request,
  services = [],
  settings = {},
  history = [],
  scope = {},
  actorToken = '',
  recentServiceId = null,
} = {}) {
  cleanupRecentDiagnosticTargets()
  cleanupPendingDiagnosticClarifications()
  pendingDiagnosticClarifications.delete(fingerprintToken(actorToken))

  const resolution =
    request.selectorSource === 'previous-list'
      ? resolveFromPreviousList({request, services, settings, history, scope})
      : request.selectorSource === 'named-target'
        ? resolveNamedTarget({request, services, scope})
        : resolveContextTarget({services, scope, actorToken, recentServiceId})

  if (resolution.status !== 'resolved') {
    if (resolution.status === 'ambiguous') {
      rememberPendingDiagnosticClarification({
        request,
        resolution,
        services,
        scope,
        actorToken,
        recentServiceId,
      })
    }

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildResolutionClarification(resolution, services),
      data: {
        type: 'clarification',
        reason: `subscription-expiry-target-${resolution.status || 'unresolved'}`,
      },
      meta: buildMeta('clarification', {
        tool: SUBSCRIPTION_EXPIRY_TOOL_ID,
        guard: `subscription-expiry-target-${resolution.status || 'unresolved'}`,
      }),
    }
  }

  const resolvedService = findResolvedService(services, resolution.item)

  if (resolvedService.status !== 'resolved') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply:
        resolvedService.status === 'grouped-row'
          ? 'La riga selezionata raggruppa più servizi. Indica il singolo servizio di cui vuoi conoscere la scadenza.'
          : 'Il servizio selezionato non è più disponibile. Ripeti la ricerca prima di procedere.',
      data: {
        type: 'clarification',
        reason: `subscription-expiry-target-${resolvedService.status}`,
      },
      meta: buildMeta('clarification', {
        tool: SUBSCRIPTION_EXPIRY_TOOL_ID,
        guard: `subscription-expiry-target-${resolvedService.status}`,
      }),
    }
  }

  const service = resolvedService.service
  const target = {
    type: 'service',
    id: String(service.id),
    label: getServiceLabel(service),
  }
  const subscriptionKind = request.subscriptionKind || 'all'
  const customerItems = sortSubscriptionExpiryItems(
    getServiceSubscriptionsByKind(service, 'customer').map(item =>
      mapSubscriptionExpiryItem(item, 'customer')
    )
  )
  const supplierItems = sortSubscriptionExpiryItems(
    getServiceSubscriptionsByKind(service, 'supplier').map(item =>
      mapSubscriptionExpiryItem(item, 'supplier')
    )
  )
  const items =
    subscriptionKind === 'customer'
      ? customerItems
      : subscriptionKind === 'supplier'
        ? supplierItems
        : [...customerItems, ...supplierItems]

  rememberDiagnosticTarget(actorToken, target)

  return {
    ok: true,
    intent: 'service-subscription-expiry',
    source: 'tool-fast',
    reply: buildSubscriptionExpiryReply({
      service,
      subscriptionKind,
      items,
    }),
    data: {
      type: 'service-subscription-expiry',
      target,
      subscriptionKind,
      items,
    },
    meta: buildMeta('service-subscription-expiry', {
      tool: SUBSCRIPTION_EXPIRY_TOOL_ID,
      targetId: target.id,
      subscriptionKind,
    }),
  }
}

function buildPleskAuditResolutionClarification(resolution = {}, services = []) {
  if (resolution.status === 'missing-list') {
    return 'Non ho una lista precedente da cui selezionare il servizio. Chiedimi prima quali servizi vuoi vedere.'
  }

  if (resolution.status === 'missing-target') {
    return 'Indica quale servizio o dominio vuoi verificare nell’audit Plesk.'
  }

  if (resolution.status === 'empty-list') {
    return 'La lista precedente non contiene servizi selezionabili.'
  }

  if (resolution.status === 'out-of-range') {
    return `La pagina corrente contiene ${
      resolution.available || 0
    } servizi. Indica una posizione compresa tra 1 e ${resolution.available || 0}.`
  }

  if (resolution.status === 'not-found') {
    return `Non ho trovato un servizio corrispondente a "${
      resolution.term || ''
    }". Indica un nome più preciso.`
  }

  if (resolution.status === 'ambiguous') {
    const rows = (resolution.candidates || []).slice(0, 8).map((candidate, index) => {
      const ids = uniqueServiceIds(candidate.item || {})
      const service = services.find(item => ids.includes(String(item?.id)))
      const domain = service?.domains_id?.name || service?.domain?.name || null

      return [
        `${index + 1}. ${service?.name || domain || 'Servizio'} (ID ${service?.id || '—'})`,
        `   Dominio: ${domain || '—'}`,
        `   Cliente: ${service?.customer?.name || '—'}`,
        `   Gruppo: ${service?.customer?.group?.name || '—'}`,
        `   Piano: ${getPrimaryPlanName(service) || '—'}`,
      ].join('\n')
    })

    return [
      `Ho trovato più servizi corrispondenti a "${resolution.term || ''}".`,
      'Quale vuoi verificare nell’audit Plesk?',
      '',
      ...rows,
      '',
      'Rispondi con il numero, con l’ID oppure con un dettaglio distintivo.',
    ].join('\n')
  }

  return 'Non sono riuscito a identificare un solo servizio. Indica il nome esatto o il numero della riga.'
}

function normalizeAuditDomain(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\.$/, '')
    .replace(/[/?#].*$/, '')
}

function getAuditIssueServiceIds(issue = {}) {
  return [
    issue?.service?.id,
    issue?.crm?.serviceId,
    ...(issue?.service?.services || []).map(service => service?.id),
    ...(issue?.service?.candidateDomains || []).map(candidate => candidate?.serviceId),
  ]
    .filter(Boolean)
    .map(String)
}

function getAuditIssueDomainIds(issue = {}) {
  return [
    issue?.service?.domainId,
    ...(issue?.service?.candidateDomains || []).map(candidate => candidate?.domainId),
  ]
    .filter(Boolean)
    .map(String)
}

function getAuditIssueDomainNames(issue = {}) {
  return [
    issue?.service?.domainName,
    issue?.plesk?.name,
    ...(issue?.service?.candidateDomains || []).map(candidate => candidate?.domainName),
  ]
    .map(normalizeAuditDomain)
    .filter(Boolean)
}

function issueMatchesServices(issue = {}, services = []) {
  if (!services.length) return false

  const serviceIds = new Set(services.map(service => String(service?.id)).filter(Boolean))
  const domainIds = new Set(
    services
      .map(service => service?.domains_id?.id || service?.domain?.id)
      .filter(Boolean)
      .map(String)
  )
  const domainNames = new Set(
    services
      .flatMap(service => [
        service?.domains_id?.name,
        service?.domain?.name,
        service?.name,
      ])
      .map(normalizeAuditDomain)
      .filter(Boolean)
  )

  if (getAuditIssueServiceIds(issue).some(id => serviceIds.has(id))) return true
  if (getAuditIssueDomainIds(issue).some(id => domainIds.has(id))) return true
  if (getAuditIssueDomainNames(issue).some(name => domainNames.has(name))) return true

  return false
}

function applyPleskAuditFilters(items = [], filters = {}) {
  const codes = new Set(
    (filters?.codes || []).filter(code => PLESK_AUDIT_CODES.has(String(code)))
  )
  const severities = new Set((filters?.severities || []).map(String))

  return items.filter(issue => {
    if (codes.size && !codes.has(String(issue?.code || ''))) return false
    if (severities.size && !severities.has(String(issue?.severity || ''))) return false
    return true
  })
}

function sortPleskAuditIssues(items = []) {
  const severityOrder = {
    error: 0,
    warning: 1,
    info: 2,
  }

  return [...items].sort((first, second) => {
    const severityDiff =
      (severityOrder[first?.severity] ?? 9) - (severityOrder[second?.severity] ?? 9)

    if (severityDiff) return severityDiff

    return String(getPleskAuditIssueLabel(first)).localeCompare(
      String(getPleskAuditIssueLabel(second)),
      'it'
    )
  })
}

function getPleskAuditIssueLabel(issue = {}) {
  const serviceNames = (issue?.service?.services || []).map(service => service?.name).filter(Boolean)

  return (
    issue?.service?.domainName ||
    issue?.crm?.serviceName ||
    issue?.plesk?.name ||
    issue?.service?.name ||
    serviceNames[0] ||
    issue?.service?.integrationId ||
    'Servizio Plesk'
  )
}

function formatAuditDate(value) {
  if (!value) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)

  return new Intl.DateTimeFormat('it-IT').format(date)
}

function describePleskAuditIssue(issue = {}) {
  if (issue.code === 'expiration_mismatch') {
    const crmDate = formatAuditDate(issue?.crm?.endsOn)
    const pleskDate = formatAuditDate(issue?.plesk?.expiration)
    const diffDays = Number(issue?.crm?.diffDays)

    return [
      crmDate ? `CRM ${crmDate}` : null,
      pleskDate ? `Plesk ${pleskDate}` : null,
      Number.isFinite(diffDays) ? `differenza ${diffDays} giorni` : null,
    ]
      .filter(Boolean)
      .join(', ')
  }

  if (issue.code === 'base_plan_mismatch') {
    const crmPlan = issue?.crm?.planName || issue?.crm?.planGuid || '—'
    const pleskPlan = issue?.plesk?.basePlanName || issue?.plesk?.basePlanGuid || '—'

    return `CRM ${crmPlan}, Plesk ${pleskPlan}`
  }

  if (issue.code === 'plesk_subscription_not_synced') {
    return 'La subscription risulta non sincronizzata con il piano Plesk'
  }

  if (issue.code === 'plesk_subscription_locked') {
    return 'La subscription risulta bloccata e potrebbe contenere personalizzazioni'
  }

  if (issue.code === 'plesk_domain_not_linked') {
    const siteId = issue?.plesk?.id ? `siteId ${issue.plesk.id}` : null
    const guid = issue?.plesk?.guid ? `GUID ${issue.plesk.guid}` : null

    return [siteId, guid].filter(Boolean).join(', ') || issue?.message || ''
  }

  if (issue.code === 'plesk_subscription_not_found') {
    const guid = issue?.crm?.integrationId || issue?.service?.integrationId
    return guid ? `GUID collegato: ${guid}` : issue?.message || ''
  }

  if (issue.code === 'missing_plesk_integration_id') {
    const pleskDomainId = issue?.service?.pleskDomainId
    return pleskDomainId
      ? `Record plesk_domain ${pleskDomainId} senza GUID sul dominio`
      : issue?.message || ''
  }

  return issue?.message || ''
}

function formatCount(value, singular, plural) {
  const count = Number(value || 0)
  return `${count} ${count === 1 ? singular : plural}`
}

function buildPleskAuditSummary(items = []) {
  return {
    total: items.length,
    errors: items.filter(issue => issue?.severity === 'error').length,
    warnings: items.filter(issue => issue?.severity === 'warning').length,
    info: items.filter(issue => issue?.severity === 'info').length,
  }
}

function describePleskAuditFilter(filters = {}) {
  const labels = []
  const codeLabels = {
    missing_plesk_integration_id: 'GUID mancanti',
    plesk_domain_not_linked: 'domini Plesk non collegati',
    plesk_subscription_not_found: 'subscription Plesk non trovate',
    expiration_mismatch: 'scadenze CRM/Plesk diverse',
    base_plan_mismatch: 'piani base diversi',
    plesk_subscription_not_synced: 'subscription non sincronizzate',
    plesk_subscription_locked: 'subscription bloccate',
  }

  for (const code of filters?.codes || []) {
    if (codeLabels[code]) labels.push(codeLabels[code])
  }

  for (const severity of filters?.severities || []) {
    if (severity === 'error') labels.push('solo errori')
    if (severity === 'warning') labels.push('solo avvisi')
  }

  return labels.length ? joinItalian(labels) : null
}

function buildPleskAuditReply({result, items, target = null, scoped = false, filters = {}}) {
  const summary = buildPleskAuditSummary(items)
  const filterLabel = describePleskAuditFilter(filters)
  const scopeLabel = target
    ? ` per "${target.label}"`
    : scoped
      ? ' nel contesto selezionato'
      : ''
  const filterSuffix = filterLabel ? `, filtro: ${filterLabel}` : ''

  if (!summary.total) {
    return `Audit Plesk completato${scopeLabel}${filterSuffix}: non ho trovato anomalie corrispondenti.`
  }

  const rows = items.slice(0, 15).map(issue => {
    const severity = issue?.severity === 'error' ? 'ERRORE' : issue?.severity === 'warning' ? 'AVVISO' : 'INFO'
    const label = getPleskAuditIssueLabel(issue)
    const details = describePleskAuditIssue(issue)

    return `- [${severity}] ${issue?.title || issue?.code || 'Anomalia'} — ${label}${
      details ? ` | ${details}` : ''
    }`
  })

  const hidden = Math.max(0, summary.total - rows.length)
  const anomalySummary = `${formatCount(summary.total, 'anomalia', 'anomalie')} (${formatCount(
    summary.errors,
    'errore',
    'errori'
  )}, ${formatCount(summary.warnings, 'avviso', 'avvisi')})`
  const checked = Number(result?.checked || 0)
  const checkedLabel = `${checked} ${checked === 1 ? 'collegamento verificato' : 'collegamenti verificati'}`
  const header = scoped || target
    ? `Audit Plesk completato${scopeLabel}${filterSuffix}: ${anomalySummary}.`
    : `Audit Plesk completato: ${checkedLabel}, ${anomalySummary}${filterSuffix}.`

  return [header, '', ...rows, hidden ? `- ... e altre ${hidden} anomalie.` : null]
    .filter(Boolean)
    .join('\n')
}

export async function handlePleskAuditRequest({
  request,
  services = [],
  settings = {},
  history = [],
  scope = {},
  actorToken = '',
  recentServiceId = null,
} = {}) {
  cleanupRecentDiagnosticTargets()
  cleanupPendingDiagnosticClarifications()
  pendingDiagnosticClarifications.delete(fingerprintToken(actorToken))

  let target = null
  let targetServices = []
  const shouldResolveSingleTarget =
    request.selectorSource !== 'all' || Boolean(scope?.serviceId)

  if (shouldResolveSingleTarget) {
    const effectiveSource =
      request.selectorSource === 'all' && scope?.serviceId ? 'context' : request.selectorSource

    const resolution =
      effectiveSource === 'previous-list'
        ? resolveFromPreviousList({
            request,
            services,
            settings,
            history,
            scope,
          })
        : effectiveSource === 'named-target'
          ? resolveNamedTarget({
              request,
              services,
              scope,
            })
          : resolveContextTarget({
              services,
              scope,
              actorToken,
              recentServiceId,
            })

    if (resolution.status !== 'resolved') {
      if (resolution.status === 'ambiguous') {
        rememberPendingDiagnosticClarification({
          request,
          resolution,
          services,
          scope,
          actorToken,
          recentServiceId,
        })
      }

      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: buildPleskAuditResolutionClarification(resolution, services),
        data: {
          type: 'clarification',
          reason: `plesk-audit-target-${resolution.status || 'unresolved'}`,
        },
        meta: buildMeta('clarification', {
          tool: PLESK_AUDIT_TOOL_ID,
          guard: `plesk-audit-target-${resolution.status || 'unresolved'}`,
        }),
      }
    }

    const resolvedService = findResolvedService(services, resolution.item)

    if (resolvedService.status !== 'resolved') {
      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply:
          resolvedService.status === 'grouped-row'
            ? 'La riga selezionata raggruppa più servizi. Indica il singolo servizio da verificare su Plesk.'
            : 'Il servizio selezionato non è più disponibile. Ripeti la ricerca prima di procedere.',
        data: {
          type: 'clarification',
          reason: `plesk-audit-target-${resolvedService.status}`,
        },
        meta: buildMeta('clarification', {
          tool: PLESK_AUDIT_TOOL_ID,
          guard: `plesk-audit-target-${resolvedService.status}`,
        }),
      }
    }

    targetServices = [resolvedService.service]
    target = {
      type: 'service',
      id: String(resolvedService.service.id),
      label: getServiceLabel(resolvedService.service),
    }
    rememberDiagnosticTarget(actorToken, target)
  } else if (scope?.customerId || scope?.groupId) {
    targetServices = applyScope(services, {
      customerId: scope.customerId,
      groupId: scope.groupId,
      serviceId: null,
    })
  }

  const auditStartedAt = Date.now()

  try {
    const result = await getPleskRenewalsAudit()
    const upstreamItems = Array.isArray(result?.items) ? result.items : []
    const scoped = targetServices.length > 0
    const scopedItems = scoped
      ? upstreamItems.filter(issue => issueMatchesServices(issue, targetServices))
      : upstreamItems
    const filteredItems = sortPleskAuditIssues(
      applyPleskAuditFilters(scopedItems, request.filters)
    )
    const summary = buildPleskAuditSummary(filteredItems)

    return {
      ok: true,
      intent: 'plesk-renewals-audit',
      source: 'tool-fast',
      reply: buildPleskAuditReply({
        result,
        items: filteredItems,
        target,
        scoped,
        filters: request.filters,
      }),
      data: {
        type: 'plesk-renewals-audit',
        target,
        scope: {
          customerId: scope?.customerId || null,
          groupId: scope?.groupId || null,
          serviceId: target?.id || scope?.serviceId || null,
        },
        filters: request.filters,
        checked: Number(result?.checked || 0),
        upstreamTotalIssues: Number(result?.totalIssues ?? upstreamItems.length),
        summary,
        items: filteredItems,
      },
      meta: buildMeta('plesk-renewals-audit', {
        tool: PLESK_AUDIT_TOOL_ID,
        targetId: target?.id || null,
        auditMs: Date.now() - auditStartedAt,
        upstreamTotalIssues: Number(result?.totalIssues ?? upstreamItems.length),
        filteredIssues: summary.total,
      }),
    }
  } catch (error) {
    return {
      ok: false,
      intent: 'plesk-renewals-audit',
      source: 'tool-fast',
      reply: 'Non è stato possibile completare l’audit Plesk in questo momento.',
      data: {
        type: 'plesk-renewals-audit',
        target,
        filters: request.filters,
        error: {
          code: 'plesk-audit-failed',
          message: error?.message || String(error),
        },
      },
      meta: buildMeta('plesk-renewals-audit', {
        tool: PLESK_AUDIT_TOOL_ID,
        targetId: target?.id || null,
        auditMs: Date.now() - auditStartedAt,
        errorCode: 'plesk-audit-failed',
      }),
    }
  }
}
