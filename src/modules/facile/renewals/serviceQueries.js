import {formatDate} from '../../../utils/formatters.js'
import {compactText, normalizeSearchText} from '../../../utils/text.js'
import {getClientSubscriptions, getServiceSpaceInfo} from './snapshots.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

const ITALIAN_LIMITS = new Map([
  ['uno', 1], ['un', 1], ['una', 1], ['due', 2], ['tre', 3], ['quattro', 4],
  ['cinque', 5], ['sei', 6], ['sette', 7], ['otto', 8], ['nove', 9], ['dieci', 10],
  ['undici', 11], ['dodici', 12], ['tredici', 13], ['quattordici', 14],
  ['quindici', 15], ['sedici', 16], ['diciassette', 17], ['diciotto', 18],
  ['diciannove', 19], ['venti', 20],
])

const MONTHS = [
  {index: 0, names: ['gennaio', 'gen']},
  {index: 1, names: ['febbraio', 'feb']},
  {index: 2, names: ['marzo', 'mar']},
  {index: 3, names: ['aprile', 'apr']},
  {index: 4, names: ['maggio', 'mag']},
  {index: 5, names: ['giugno', 'giu']},
  {index: 6, names: ['luglio', 'lug']},
  {index: 7, names: ['agosto', 'ago']},
  {index: 8, names: ['settembre', 'sett', 'set']},
  {index: 9, names: ['ottobre', 'ott']},
  {index: 10, names: ['novembre', 'nov']},
  {index: 11, names: ['dicembre', 'dic']},
]

const STOP_WORDS = [
  'con',
  'che',
  'contiene',
  'contengono',
  'contenente',
  'del',
  'della',
  'dei',
  'delle',
  'di',
  'il',
  'la',
  'lo',
  'le',
  'i',
  'gli',
  'un',
  'una',
]

function includesText(value, q) {
  const needle = normalizeSearchText(q)

  if (!needle) {
    return false
  }

  return normalizeSearchText(value).includes(needle)
}

function cleanTerm(value = '') {
  let text = compactText(value)
    .replace(/[?.!,;:]+$/g, '')
    .replace(/^['"“”]+|['"“”]+$/g, '')
    .trim()

  const lower = normalizeSearchText(text)
  const words = lower.split(' ')

  while (words.length && STOP_WORDS.includes(words[0])) {
    words.shift()
  }

  if (words.length !== lower.split(' ').length) {
    text = words.join(' ')
  }

  return compactText(text)
}

function stripAfterKnownTail(value = '') {
  return compactText(value)
    .replace(
      /\b(?:senza|escludi|escludendo|esclusi|escluse|tranne|eccetto)\b.{0,60}\b(?:i\s+|gli\s+)?(?:da\s+)?non\s+rinnovare\b.*$/i,
      ''
    )
    .replace(
      /\bnon\s+(?:includere|includi|considerare|considera)\b.{0,60}\b(?:i\s+|gli\s+)?(?:da\s+)?non\s+rinnovare\b.*$/i,
      ''
    )
    .replace(
      /\b(?:includi|includendo|anche|compresi|comprese|inclusi|incluse)\b.{0,60}\b(?:i\s+|gli\s+)?(?:da\s+)?non\s+rinnovare\b.*$/i,
      ''
    )
    .replace(
      /\b(?:da\s+non\s+rinnovare|non\s+rinnovare)\b.{0,60}\b(?:inclusi|incluse|compresi|comprese|anche|esclusi|escluse|da\s+escludere|non\s+inclusi|non\s+incluse)\b.*$/i,
      ''
    )
    .replace(
      /\b(con dettagli|dettagli|con dettaglio|mostrami|mostra|elencami|elenca|elencando|fammi|dimmi|solo|soltanto|al massimo|massimo|i primi|le prime|primi|prime|esempi?|servizi?|domini?)\b.*$/i,
      ''
    )
    .replace(/\b(ordinati|ordinate|ordine|per favore)\b.*$/i, '')
    .trim()
}

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, 1), MAX_LIMIT)
}

function parseLimitToken(value = '') {
  const token = normalizeSearchText(value)
  if (!token) return null
  const parsed = /^\d+$/.test(token) ? Number(token) : ITALIAN_LIMITS.get(token)
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), MAX_LIMIT) : null
}

function isReservedBareServiceTerm(value = '') {
  const text = normalizeSearchText(value)
  if (!text) return true

  if (
    /^(che|con|senza|di|tipo|piano|plan|spazio|fornitore|provider|supplier|collegato|collegati|non|marcato|marcati|da|in|nel|nell|hanno|ha|sono)\b/.test(
      text
    )
  ) {
    return true
  }

  return /^(hosting|web hosting|pec|casella pec|dominio|domini|email|mail|backup|licenza|licenze|server|vps|cloud|plesk|rinnovo|rinnovi|rinnovano|scadenza|scadenze|scade|scadono|scadra|scadranno|scaduto|scaduti|imminente|imminenti|fatturazione|auth code|record dominio|traffico|spazio)\b/.test(
    text
  )
}

function isOperationalScopeTerm(value = '') {
  const text = normalizeSearchText(value)

  if (!text) return true

  return (
    isReservedBareServiceTerm(text) ||
    /\b(?:scadenza|scadenze|scade|scadono|scadra|scadranno|rinnovo|rinnovi|rinnovano|imminente|imminenti|spazio|quota|plesk|fatturazione|fornitore|provider|supplier|auth\s*code|comunicazioni|traffico)\b/.test(
      text
    )
  )
}

function stripCustomerOrGroupTail(value = '') {
  return compactText(
    stripAfterKnownTail(value)
      .replace(
        /\b(?:che\s+)?(?:scade|scadono|scadra|scadranno|rinnova|rinnovano|termina|terminano|ha|hanno|è|sono)\b.*$/i,
        ''
      )
      .replace(
        /\b(?:con|senza|in|da|per)\s+(?:rinnovi?|scadenz[ae]|spazio|quota|plesk|fatturazione|fornitor[ei]|provider|supplier|auth\s*code|comunicazioni|traffico)\b.*$/i,
        ''
      )
      .trim()
  )
}

function normalizeCustomerOrGroupTerm(value = '') {
  const term = cleanTerm(stripCustomerOrGroupTail(value))

  if (!term || isOperationalScopeTerm(term)) {
    return null
  }

  return term
}

function isExplicitSupplierExpiryRequest(message = '') {
  const text = normalizeSearchText(message)

  return (
    /\b(?:scadenza|scadenze|scade|scadono|scadra|scadranno)\b.{0,40}\b(?:fornitore|supplier|provider)\b/.test(
      text
    ) ||
    /\b(?:fornitore|supplier|provider)\b.{0,40}\b(?:scadenza|scadenze|scade|scadono|scadra|scadranno)\b/.test(
      text
    )
  )
}

function isTemporalOrOperationalTerm(value = '') {
  const text = normalizeSearchText(value)

  if (!text) return true

  const isOnlyYear = /^(?:(?:nel|nell|del|dell|al|dal|entro|tra|fra|in)\s+)?20\d{2}$/.test(
    text
  )
  const isOnlyMonth = MONTHS.some(month =>
    month.names.some(name =>
      new RegExp(
        `^(?:(?:nel|nell|del|dell|al|dal|entro|tra|fra|in)\\s+)?${name}(?:\\s+20\\d{2})?$`,
        'i'
      ).test(text)
    )
  )

  return (
    isOnlyYear ||
    isOnlyMonth ||
    /^(?:nel|nell|in|entro|tra|fra|dal|dall|al)\b/.test(text) ||
    /\b(?:scadenza|scadenze|scade|scadono|scadra|scadranno|rinnovo|rinnovi|imminente|imminenti|servizio|servizi|dominio|domini)\b/.test(
      text
    )
  )
}

function extractLimit(message = '') {
  const text = normalizeSearchText(message)
  const amount = '(\\d{1,2}|uno|un|una|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette|diciotto|diciannove|venti)'

  const morePatterns = [
    new RegExp(`\\b(?:mostramene|dammene|elencamene)\\s+(?:altr[ei]\\s+)?${amount}\\b`, 'i'),
    new RegExp(`\\b(?:altr[ei]|successiv[ei]|prossim[ei]|seguent[ei])\\s+${amount}\\b`, 'i'),
    new RegExp(`\\b(?:mostra|mostrami|dammi|elenca|elencami)\\s+(?:i\\s+)?(?:successiv[ei]|prossim[ei]|altr[ei])\\s+${amount}\\b`, 'i'),
  ]

  for (const pattern of morePatterns) {
    const match = text.match(pattern)

    if (match?.[1]) {
      return {
        limit: parseLimitToken(match[1]) || DEFAULT_LIMIT,
        offset: DEFAULT_LIMIT,
        requestedLimit: true,
        requestedAll: false,
        requestedMore: true,
      }
    }
  }

  const patterns = [
    new RegExp(`(?:fammi|dammi|mostrami|mostramene|elencami|voglio|solo|soltanto|al massimo|massimo|primi|prime|i primi|le prime)\\s+${amount}\\b`, 'i'),
    new RegExp(`\\b${amount}\\s+(?:esempi|servizi|risultati|voci)\\b`, 'i'),
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      return {
        limit: parseLimitToken(match[1]) || DEFAULT_LIMIT,
        offset: 0,
        requestedLimit: true,
        requestedAll: false,
        requestedMore: false,
      }
    }
  }

  if (/\b(tutti|tutte|elenco completo|lista completa)\b/i.test(text)) {
    return {
      limit: MAX_LIMIT,
      offset: 0,
      requestedLimit: false,
      requestedAll: true,
      requestedMore: false,
    }
  }

  return {
    limit: DEFAULT_LIMIT,
    offset: 0,
    requestedLimit: false,
    requestedAll: false,
    requestedMore: false,
  }
}

function isCountOnlyRequest(message = '') {
  return /\b(?:quanti|quante|conta|conteggio|numero totale)\b/i.test(
    normalizeSearchText(message)
  )
}

function restoreDateRange(dateRange = null) {
  if (!dateRange) return null

  const start = parseDateValue(dateRange.start)
  const end = parseDateValue(dateRange.end)

  if (!start || !end) {
    return null
  }

  return {
    ...dateRange,
    start,
    end,
  }
}

function restoreServiceListFilters(filters = []) {
  return (Array.isArray(filters) ? filters : []).map(filter => ({
    ...filter,
    dateRange: restoreDateRange(filter?.dateRange),
  }))
}

function buildQueryFromPreviousState({
  previousQuery = {},
  pagination = {},
  fallbackMessage = '',
} = {}) {
  const safePreviousQuery = previousQuery || {}
  const safePagination = pagination || {}
  const filters = restoreServiceListFilters(safePreviousQuery.filters)
  const fallbackLimit = clampLimit(safePreviousQuery.limit, DEFAULT_LIMIT)
  const limit = clampLimit(safePagination.limit, fallbackLimit)
  const offset = Math.max(Number(safePagination.offset || 0), 0)

  return {
    type: 'service-list-query',
    label: safePreviousQuery.label || describeFilters(filters),
    filters,
    limit,
    offset,
    requestedLimit: Boolean(safePagination.limit),
    requestedAll: false,
    requestedMore: safePagination.direction === 'next',
    requestedPrevious: safePagination.direction === 'previous',
    requestedFirst: safePagination.direction === 'first',
    sourceMessage: safePreviousQuery.sourceMessage || compactText(fallbackMessage),
    includeDontRenew:
      typeof safePreviousQuery.includeDontRenew === 'boolean'
        ? safePreviousQuery.includeDontRenew
        : null,
  }
}

function parseDateValue(value) {
  if (!value) return null

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
}

function buildMonthRange(monthIndex, year) {
  const start = new Date(year, monthIndex, 1)
  const end = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999)

  return {start, end}
}

function buildYearRange(year) {
  return {
    start: new Date(year, 0, 1),
    end: new Date(year, 11, 31, 23, 59, 59, 999),
  }
}

function resolveMonthYear(monthIndex, explicitYear = null, now = new Date()) {
  if (explicitYear) return Number(explicitYear)

  const currentYear = now.getFullYear()

  if (monthIndex >= now.getMonth()) {
    return currentYear
  }

  return currentYear + 1
}

function extractDateRange(message = '', now = new Date()) {
  const original = String(message || '')
  const text = normalizeSearchText(original)

  const numericDate = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/)

  if (numericDate) {
    const day = Number(numericDate[1])
    const month = Number(numericDate[2]) - 1
    const yearRaw = numericDate[3]
    const year = yearRaw
      ? Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw)
      : resolveMonthYear(month, null, now)

    const date = new Date(year, month, day)

    if (!Number.isNaN(date.getTime())) {
      return {
        type: 'day',
        start: startOfDay(date),
        end: endOfDay(date),
        label: formatDate(date),
      }
    }
  }

  const isoMonth = text.match(/\b(20\d{2})-(\d{1,2})\b/)

  if (isoMonth) {
    const year = Number(isoMonth[1])
    const month = Number(isoMonth[2]) - 1
    const range = buildMonthRange(month, year)

    return {
      type: 'month',
      ...range,
      label: `${MONTHS[month]?.names?.[0] || String(month + 1)} ${year}`,
    }
  }

  const numericMonth = text.match(/\b(\d{1,2})[/-](20\d{2})\b/)

  if (numericMonth) {
    const month = Number(numericMonth[1]) - 1
    const year = Number(numericMonth[2])

    if (month >= 0 && month <= 11) {
      const range = buildMonthRange(month, year)

      return {
        type: 'month',
        ...range,
        label: `${MONTHS[month]?.names?.[0] || String(month + 1)} ${year}`,
      }
    }
  }

  for (const month of MONTHS) {
    const foundName = month.names.find(name => new RegExp(`\\b${name}\\b`, 'i').test(text))

    if (!foundName) continue

    const afterMonth = text.match(new RegExp(`\\b${foundName}\\s+(20\\d{2})\\b`, 'i'))
    const beforeMonth = text.match(new RegExp(`\\b(20\\d{2})\\s+${foundName}\\b`, 'i'))
    const dayMonth = text.match(
      new RegExp(`\\b(\\d{1,2})\\s+${foundName}(?:\\s+(20\\d{2}))?\\b`, 'i')
    )

    const year = resolveMonthYear(
      month.index,
      afterMonth?.[1] || beforeMonth?.[1] || dayMonth?.[2],
      now
    )

    if (dayMonth?.[1]) {
      const date = new Date(year, month.index, Number(dayMonth[1]))

      return {
        type: 'day',
        start: startOfDay(date),
        end: endOfDay(date),
        label: formatDate(date),
      }
    }

    const range = buildMonthRange(month.index, year)

    return {
      type: 'month',
      ...range,
      label: `${month.names[0]} ${year}`,
    }
  }

  /*
   * Un anno isolato è un intervallo temporale soltanto quando la frase
   * contiene anche un concetto di scadenza/rinnovo/fatturazione. In questo
   * modo "piano 2027" non viene trasformato accidentalmente in un filtro data.
   */
  const yearOnly = text.match(/\b(20\d{2})\b/)
  const hasTemporalContext =
    /\b(?:scadenza|scadenze|scade|scadono|scadra|scadranno|rinnovo|rinnovi|rinnovano|termina|terminano|fatturazione|fattura|invoice)\b/.test(
      text
    )

  if (yearOnly?.[1] && hasTemporalContext) {
    const year = Number(yearOnly[1])
    const isDeadlineYear = new RegExp(
      `\\b(?:entro|fino|sino)(?:\\s+(?:a|al|alla|il))?\\s+(?:la\\s+fine\\s+del\\s+)?${year}\\b`
    ).test(text)

    if (isDeadlineYear) {
      return {
        type: 'deadline-year',
        start: startOfDay(now),
        end: buildYearRange(year).end,
        label: `entro il ${year}`,
      }
    }

    return {
      type: 'year',
      ...buildYearRange(year),
      label: String(year),
    }
  }

  return null
}

function isWithin(date, range) {
  if (!date || !range?.start || !range?.end) return false

  const time = date.getTime()
  return time >= range.start.getTime() && time <= range.end.getTime()
}

function getSupplierSubscriptions(service) {
  return (service?.subscriptions || []).filter(sub => sub?.isSupplier === true)
}

function getNestedSupplierSubscriptions(service) {
  return (service?.subscriptions || [])
    .flatMap(sub => sub?.suppliersSubscriptions || sub?.supplierSubscriptions || [])
    .filter(Boolean)
}

function getAllSupplierSubscriptions(service) {
  return [...getSupplierSubscriptions(service), ...getNestedSupplierSubscriptions(service)]
}

function getSubscriptionDate(sub) {
  return parseDateValue(sub?.endsOn || sub?.ends_on)
}

function getCustomerSubscriptionDates(service) {
  return getClientSubscriptions(service)
    .map(getSubscriptionDate)
    .filter(Boolean)
    .sort((a, b) => a - b)
}

function getSupplierSubscriptionDates(service) {
  return getAllSupplierSubscriptions(service)
    .map(getSubscriptionDate)
    .filter(Boolean)
    .sort((a, b) => a - b)
}

function getNextCustomerExpiry(service, now = new Date()) {
  const dates = getCustomerSubscriptionDates(service)
  const future = dates.filter(date => date >= now)

  return future[0] || dates[0] || null
}

function getExpiredCustomerExpiry(service, now = new Date()) {
  const dates = getCustomerSubscriptionDates(service).filter(date => date < now)

  return dates.sort((a, b) => b - a)[0] || null
}

function hasCustomerExpiryWithin(service, range) {
  return getCustomerSubscriptionDates(service).some(date => isWithin(date, range))
}

function hasSupplierExpiryWithin(service, range) {
  return getSupplierSubscriptionDates(service).some(date => isWithin(date, range))
}

function pushCleanName(out, value) {
  if (!value) return

  if (typeof value === 'string') {
    const text = compactText(value)
    if (text) out.push(text)
    return
  }

  if (typeof value === 'object') {
    const text = compactText(value.name || value.label || '')
    if (text) out.push(text)
  }
}

function getServiceTypeNames(service) {
  const out = []

  for (const type of service?.servicesTypes || []) {
    pushCleanName(out, type?.name)
    pushCleanName(out, type?.macro?.name || type?.macro)
  }

  return [...new Set(out)]
}

function getPlanRefsFromSubscription(sub) {
  const refs = []

  if (sub?.plan) {
    refs.push({
      id: sub.plan.id || null,
      name: sub.plan.name || null,
      description: sub.plan.description || null,
      supplier: sub.plan.supplier?.name || sub.plan.supplier || null,
      missingPrice: sub.plan.missingPrice === true,
      source: sub.isSupplier ? 'supplier' : 'customer',
    })
  }

  for (const addon of sub?.addons || []) {
    refs.push({
      id: addon.addonId || addon.id || null,
      name: addon.name || null,
      description: addon.description || null,
      supplier: addon.supplier?.name || addon.supplier || null,
      missingPrice: addon.missingPrice === true,
      source: sub.isSupplier ? 'supplier-addon' : 'addon',
    })
  }

  return refs
}

function getPlanRefKey(plan = {}) {
  return [
    plan.id || '',
    normalizeSearchText(plan.name || ''),
    normalizeSearchText(plan.description || ''),
    normalizeSearchText(plan.supplier || ''),
    normalizeSearchText(plan.source || ''),
    plan.missingPrice ? 'missing-price' : '',
  ].join('|')
}

function uniquePlanRefs(plans = []) {
  const map = new Map()

  for (const plan of plans) {
    const key = getPlanRefKey(plan)
    if (!map.has(key)) {
      map.set(key, plan)
    }
  }

  return [...map.values()]
}

function getPlanRefs(service) {
  const direct = (service?.subscriptions || []).flatMap(getPlanRefsFromSubscription)
  const nested = getNestedSupplierSubscriptions(service).flatMap(sub =>
    getPlanRefsFromSubscription({...sub, isSupplier: true})
  )

  return uniquePlanRefs([...direct, ...nested]).filter(
    plan => plan?.name || plan?.description || plan?.id
  )
}

function getCustomerPlanRefs(service) {
  return uniquePlanRefs(getClientSubscriptions(service).flatMap(getPlanRefsFromSubscription))
}

function getSupplierNames(service) {
  return getPlanRefs(service)
    .map(plan => plan?.supplier)
    .filter(Boolean)
    .map(value => (typeof value === 'object' ? value?.name : value))
    .filter(Boolean)
}

function hasMatchingPlan(service, term) {
  return getPlanRefs(service).some(plan => {
    return includesText(plan?.name, term) || includesText(plan?.description, term)
  })
}

function getMatchingPlans(service, term = null) {
  const plans = getPlanRefs(service)

  if (!term) return plans

  return plans.filter(
    plan => includesText(plan?.name, term) || includesText(plan?.description, term)
  )
}

function hasMissingPrice(service) {
  return getPlanRefs(service).some(plan => plan.missingPrice === true)
}

function getDomainName(service) {
  return service?.domains_id?.name || service?.domain?.name || service?.name || null
}

function hasPleskDomain(service) {
  return Boolean(service?.pleskDomain?.id)
}

function hasDomainRecord(service) {
  return Boolean(service?.domains_id?.id || service?.domain?.id)
}

function isDontRenewService(service) {
  return service?.dontRenew === true || service?.dont_renew === true
}

function getDontRenewInclusionMode(message = '') {
  const text = normalizeSearchText(message)

  if (
    /\b(senza|escludi|escludendo|esclusi|escluse|tranne|eccetto)\b.{0,50}\b(non rinnovare|da non rinnovare)\b/.test(
      text
    ) ||
    /\b(non rinnovare|da non rinnovare)\b.{0,50}\b(esclusi|escluse|da escludere|non inclusi|non incluse)\b/.test(
      text
    ) ||
    /\bnon\s+(includere|includi|considerare|considera)\b.{0,50}\b(non rinnovare|da non rinnovare)\b/.test(
      text
    )
  ) {
    return false
  }

  if (
    /\b(includi|includendo|inclusi|incluse|compresi|comprese|anche)\b.{0,50}\b(non rinnovare|da non rinnovare)\b/.test(
      text
    ) ||
    /\b(non rinnovare|da non rinnovare)\b.{0,50}\b(inclusi|incluse|compresi|comprese|anche)\b/.test(
      text
    )
  ) {
    return true
  }

  return null
}

function hasExplicitDontRenewInclusion(message = '') {
  return getDontRenewInclusionMode(message) === true
}

function hasExplicitDontRenewExclusion(message = '') {
  return getDontRenewInclusionMode(message) === false
}

function isOperationalQuery(filters = []) {
  return filters.some(filter =>
    [
      'space-full',
      'space-low',
      'expiring',
      'expired',
      'expired-over-month',
      'expires-in-range',
      'billing',
    ].includes(filter.kind)
  )
}

function shouldIncludeDontRenew({message = '', filters = [], requestedAll = false} = {}) {
  const dontRenewMode = getDontRenewInclusionMode(message)

  if (hasFilter(filters, 'dont-renew')) return true
  if (
    filters.some(filter =>
      filter.kind === 'operational-flags-any' && filter.flags?.includes('dont-renew')
    )
  ) return true
  if (dontRenewMode === true) return true
  if (dontRenewMode === false) return false
  if (!isOperationalQuery(filters)) return true
  if (requestedAll) return true

  return false
}

function getInvoiceDate(service) {
  return parseDateValue(service?.invoiceDate || service?.invoice_date)
}

function getLastCommunicationDate(service) {
  return (service?.renewalsCommunications || [])
    .map(item => parseDateValue(item?.communicationDate || item?.communication_date))
    .filter(Boolean)
    .sort((a, b) => b - a)[0]
}

function getServiceTraffic(service) {
  return Number(service?.pleskDomain?.statsTraffic?.totalTraffic || 0)
}

function matchesCustomerOrGroup(service, term) {
  return (
    includesText(service?.customer?.name, term) ||
    includesText(service?.customer?.businessName, term) ||
    includesText(service?.customer?.group?.name, term)
  )
}

function matchesServiceType(service, term) {
  return getServiceTypeNames(service).some(name => includesText(name, term))
}

function matchesSupplier(service, term = null) {
  const hasSupplier =
    getAllSupplierSubscriptions(service).length > 0 || getSupplierNames(service).length > 0

  if (!term) return hasSupplier

  return getSupplierNames(service).some(name => includesText(name, term))
}

function extractQuotedTerm(message = '') {
  const match = String(message || '').match(/["“”']([^"“”']{2,})["“”']/)
  return match?.[1] ? cleanTerm(match[1]) : null
}

function extractPlanTerm(message = '') {
  const quoted = extractQuotedTerm(message)
  const text = String(message || '')

  if (/\b(no\s*sync|sync|sincronizzat[oi])\b/i.test(text) && /\bpian[oi]\b/i.test(text)) {
    return null
  }

  if (!/\b(pian[oi]|plan|abbonament[oi])\b/i.test(text)) {
    return null
  }

  if (quoted) return quoted

  const match = text.match(
    /\b(?:pian[oi]|plan|abbonament[oi])\b\s*(?:che\s+)?(?:contien[ea]|contengono|contenente|con|di|del|della|nome|chiamat[oi])?\s+([a-z0-9._@/+ -]{2,})/i
  )

  if (!match?.[1]) return null

  const term = stripAfterKnownTail(match[1])
    .replace(
      /\b(da\s+non\s+rinnovare|da\s+rinnovare|da\s+trasferire|in scadenza|scadut[oi]|rinnovi?|rinnovare|automatic[oi]|collegat[oi]|plesk|cliente|gruppo|tipo|fornitore|fatturazione)\b.*$/i,
      ''
    )
    .trim()

  const cleaned = cleanTerm(term)

  if (/^(da\s+)?(non\s+)?rinnovare$|^da\s+trasferire$/i.test(cleaned)) {
    return null
  }

  return cleaned
}

function extractSupplierTerm(message = '') {
  const text = String(message || '')

  if (!/\b(fornitor[ei]|supplier|provider)\b/i.test(text)) return null

  const quoted = extractQuotedTerm(text)
  if (quoted) return quoted

  const match = text.match(
    /\b(?:fornitor[ei]|supplier|provider)\b\s*(?:con|di|del|della|nome)?\s*([a-z0-9._@/+ -]{2,})?/i
  )
  const term = cleanTerm(
    stripAfterKnownTail(match?.[1] || '')
      .replace(
        /\b(?:con|in|da|per)?\s*(?:scadenz[ae]|scade|scadono|scadra|scadranno|scadut[oi]|rinnovi?|automatic[oi]|servizi?|pian[oi])\b.*$/i,
        ''
      )
      .replace(/\b(?:con|in|da|per)$/i, '')
      .trim()
  )

  if (!term || isTemporalOrOperationalTerm(term)) {
    return null
  }

  return term
}

function extractServiceTypeTerm(message = '') {
  const text = String(message || '')
  const normalized = normalizeSearchText(text)

  const explicit = text.match(
    /\b(?:tipo(?:logia)?(?:\s+di\s+servizio)?|servizi?\s+di\s+tipo)\b\s*(?:servizio)?\s*([a-z0-9._@/+ -]{2,})/i
  )

  if (explicit?.[1]) {
    return cleanTerm(stripAfterKnownTail(explicit[1]))
  }

  const knownTypes = [
    'pec',
    'casella pec',
    'dominio',
    'domini',
    'hosting',
    'web hosting',
    'email',
    'mail',
    'smtp',
    'backup',
    'licenza',
    'licenze',
    'server',
    'vps',
    'cloud',
  ]

  const found = knownTypes.find(type => new RegExp(`\\b${type}\\b`, 'i').test(normalized))

  return found || null
}

function extractCustomerOrGroupTerm(message = '') {
  const text = String(message || '')

  const explicit = text.match(/\b(?:cliente|azienda|gruppo)\b\s+([a-z0-9._@/+ -]{2,})/i)

  const explicitPrefix = explicit?.index == null ? '' : text.slice(0, explicit.index)
  if (explicit?.[1] && !/\b(?:esclud\w*|tranne|eccetto)\s*$/i.test(explicitPrefix)) {
    return normalizeCustomerOrGroupTerm(explicit[1])
  }

  const servicesOf = text.match(
    /\bservizi?\s+di\s+(?!tipo\b|piano\b|spazio\b|fornitore\b)([a-z0-9._@/+ -]{2,})/i
  )

  if (servicesOf?.[1]) {
    return normalizeCustomerOrGroupTerm(servicesOf[1])
  }

  const terseServicesOf = text.match(
    /\b(?:servizi|domini)\s+(?!che\b|di\b|con\b|senza\b|esclud\w*\b|tranne\b|eccetto\b|tipo\b|pian[oi]\b|plan\b|spazio\b|fornitor[ei]\b|provider\b|supplier\b|collegat[oi]\b|non\b|marcat[oi]\b|rinnovi?\b|rinnovano\b|scadenze?\b|scade\b|scadono\b|scadra\b|scadranno\b|scadut[oi]\b|hanno\b|ha\b|sono\b|in\b|da\b|auth\b|record\b|fatturazione\b|traffico\b)([a-z0-9._@/+ -]{2,})/i
  )

  if (terseServicesOf?.[1]) {
    const term = normalizeCustomerOrGroupTerm(terseServicesOf[1])

    if (term) {
      return term
    }
  }

  const listOf = text.match(
    /\b(?:elenco|lista)\s+(?:servizi|domini)?\s*(?:di\s+)?(?!che\b|con\b|senza\b|tipo\b|pian[oi]\b|plan\b|spazio\b|fornitor[ei]\b|provider\b|supplier\b|scade\b|scadono\b|scadra\b|scadranno\b|rinnovi?\b)([a-z0-9._@/+ -]{2,})/i
  )

  if (listOf?.[1]) {
    const term = normalizeCustomerOrGroupTerm(listOf[1])

    if (term) {
      return term
    }
  }

  return null
}

function extractCustomerOrGroupExclusion(message = '') {
  const match = String(message || '').match(
    /\b(?:esclud\w*|tranne|eccetto)\s+(?:(?:il|lo|la|i|gli|le)\s+)?(?:(?:cliente|azienda|gruppo)\s+)?(.+?)(?=\s+(?:e|ed|poi)\s+(?:mostra\w*|elenca\w*|dimmi|confront\w*|ordina\w*|calcola\w*)\b|[,;.!?]|$)/i
  )
  const term = normalizeCustomerOrGroupTerm(match?.[1] || '')

  if (!term || /\b(?:non\s+rinnovare|da\s+non\s+rinnovare)\b/i.test(term)) return null

  return term
}

function detectAlternativeOperationalFlags(message = '') {
  const text = normalizeSearchText(message)
  const definitions = [
    {kind: 'dont-renew', pattern: /\b(?:da\s+)?non\s+rinnovare\b/g},
    {kind: 'to-renew', pattern: /\bda\s+rinnovare\b/g},
    {kind: 'to-transfer', pattern: /\bda\s+(?:trasferire|migrare|spostare)\b/g},
  ]
  const mentions = definitions
    .flatMap(definition => [...text.matchAll(definition.pattern)].map(match => ({
      kind: definition.kind,
      index: match.index,
      end: match.index + match[0].length,
    })))
    .sort((first, second) => first.index - second.index)

  for (let index = 0; index < mentions.length - 1; index += 1) {
    const first = mentions[index]
    const second = mentions[index + 1]
    const connector = text.slice(first.end, second.index)

    if (/\b(?:o|oppure)\b/.test(connector)) {
      return [...new Set([first.kind, second.kind])]
    }
  }

  return []
}

function detectSpaceUsageThreshold(message = '') {
  const text = normalizeSearchText(message)
  if (!/\b(?:spazio|quota|disco)\b/.test(text)) return null

  const match = text.match(
    /\b(?:oltre|piu\s+di|superiore\s+(?:a|al)|almeno)\s+(?:(?:il|lo|la)\s+)?(\d{1,3}(?:[.,]\d+)?)\s*%/
  )
  const threshold = Number(String(match?.[1] || '').replace(',', '.'))
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) return null

  return {
    kind: 'space-usage-gte',
    label: `con spazio utilizzato almeno al ${threshold}%`,
    threshold,
  }
}

function detectBooleanFilters(message = '') {
  const text = normalizeSearchText(message)
  const filters = []
  const alternativeFlags = detectAlternativeOperationalFlags(message)

  if (alternativeFlags.length > 1) {
    filters.push({
      kind: 'operational-flags-any',
      label: 'marcati con almeno uno dei flag richiesti',
      flags: alternativeFlags,
    })
  }

  if (
    /\bspazio\b.{0,40}\b(esaurito|pieno|finito|satur[oa])\b|\bquota\b.{0,40}\b(esaurita|piena)\b|\b(esaurit[oa]|pien[oa]|finit[oa]|satur[oa])\b.{0,40}\b(spazio|quota|disco)\b/.test(
      text
    )
  ) {
    filters.push({kind: 'space-full', label: 'spazio esaurito'})
  } else if (
    /\bspazio\b.{0,40}\b(in esaurimento|quasi pien[oi]|quasi esaurit[oi]|scarso)\b|\bquota\b.{0,40}\b(in esaurimento|quasi piena)\b/.test(
      text
    )
  ) {
    filters.push({kind: 'space-low', label: 'spazio in esaurimento'})
  }

  if (
    /\bda non rinnovare\b|\bnon rinnovare\b|\bnon rinnovo\b/.test(text) &&
    !alternativeFlags.includes('dont-renew') &&
    !hasExplicitDontRenewInclusion(message) &&
    !hasExplicitDontRenewExclusion(message)
  ) {
    filters.push({kind: 'dont-renew', label: 'marcati NON RINNOVARE'})
  }

  if (
    /\bda rinnovare\b|\bto[_ -]?renew\b/.test(text) &&
    !alternativeFlags.includes('to-renew') &&
    !/\bnon rinnovare\b/.test(text)
  ) {
    filters.push({kind: 'to-renew', label: 'marcati DA RINNOVARE'})
  }

  if (
    /\bda trasferire\b|\bda migrare\b|\bda spostare\b|\bto[_ -]?transfer\b/.test(text) &&
    !alternativeFlags.includes('to-transfer')
  ) {
    filters.push({kind: 'to-transfer', label: 'marcati DA TRASFERIRE'})
  }

  if (
    /\b(senza|non)\s+rinnov[oi]\s+automatic[oi]\b|\bauto\s*renew\s*(false|no|off)\b|\bautorenew\s*(false|no|off)\b/.test(
      text
    )
  ) {
    filters.push({kind: 'no-auto-renew', label: 'senza rinnovo automatico'})
  } else if (
    /\brinnov[oi]\s+automatic[oi]\b|\brinnovo\s+automatico\b|\brinnovi\s+automatici\b|\bauto\s*renew\b|\bautorenew\b/.test(
      text
    )
  ) {
    filters.push({kind: 'auto-renew', label: 'con rinnovo automatico'})
  }

  if (
    /\b(no\s*sync|non\s+sincronizzat[oi]|pian[oi]\s+non\s+sincronizzat[oi]|plesk\s+plans?\s+sync\s*(false|no))\b/.test(
      text
    )
  ) {
    filters.push({kind: 'no-plesk-sync', label: 'con piani Plesk non sincronizzati'})
  } else if (/\b(pian[oi]\s+sincronizzat[oi]|plesk\s+plans?\s+sync|sync\s+pian[oi])\b/.test(text)) {
    filters.push({kind: 'plesk-sync', label: 'con piani Plesk sincronizzati'})
  }

  if (
    /\b(?:senza|non\s+(?:sono\s+)?collegat[oi](?:\s+a)?)\s+plesk\b|\bsenza\s+(?:alcun\s+)?(?:collegamento|connessione|associazione)(?:\s+(?:a|con))?\s+plesk\b|\bplesk\s+(?:mancante|assente|non collegato)\b/.test(
      text
    )
  ) {
    filters.push({kind: 'no-plesk', label: 'non collegati a Plesk'})
  } else if (/\b(?:collegat[oi](?:\s+a)?\s+plesk|con\s+plesk|plesk\s+collegato)\b/.test(text)) {
    filters.push({kind: 'has-plesk', label: 'collegati a Plesk'})
  }

  if (
    /\b(senza|non)\s+(dominio|record dominio)\b|\brecord dominio\s+(mancante|assente)\b/.test(text)
  ) {
    filters.push({kind: 'no-domain-record', label: 'senza record dominio'})
  } else if (/\b(con|collegat[oi]\s+a?)\s+(dominio|record dominio)\b/.test(text)) {
    filters.push({kind: 'has-domain-record', label: 'con record dominio'})
  }

  if (/\b(prezzo|prezzi|listino)\b.{0,30}\b(mancante|mancanti|assente|assenti)\b/.test(text)) {
    filters.push({kind: 'missing-price', label: 'con prezzo mancante'})
  }

  if (/\bfatturazione\b|\bda fatturare\b|\bin fattura\b|\binvoice\b/.test(text)) {
    filters.push({kind: 'billing', label: 'in fatturazione'})
  }

  if (/\b(con|hanno|ha)\s+(auth\s*code|codice auth|authorization code)\b/.test(text)) {
    filters.push({kind: 'has-auth-code', label: 'con auth code'})
  } else if (
    /\b(senza|manca|mancante)\s+(auth\s*code|codice auth|authorization code)\b/.test(text)
  ) {
    filters.push({kind: 'no-auth-code', label: 'senza auth code'})
  }

  if (/\b(con|hanno|ha)\s+comunicazioni\b|\bcomunicazioni\s+inviate\b/.test(text)) {
    filters.push({kind: 'has-communications', label: 'con comunicazioni inviate'})
  } else if (/\b(senza|nessuna)\s+comunicazioni?\b/.test(text)) {
    filters.push({kind: 'no-communications', label: 'senza comunicazioni inviate'})
  }

  if (/\b(con|hanno|ha)\s+traffico\b|\btraffico\s+(presente|rilevato)\b/.test(text)) {
    filters.push({kind: 'has-traffic', label: 'con traffico rilevato'})
  }

  const spaceUsageThreshold = detectSpaceUsageThreshold(message)
  if (spaceUsageThreshold) filters.push(spaceUsageThreshold)

  return filters
}

function detectExpiryFilters(message = '', dateRange = null) {
  const text = normalizeSearchText(message)
  const filters = []

  if (/\b(scadut[oi]|scadenza passata|gia scadut[oi])\b/.test(text)) {
    if (
      /\b(pi[uù]?\s+di\s+un\s+mese|oltre\s+un\s+mese|da\s+pi[uù]?\s+di\s+30\s+giorni)\b/.test(text)
    ) {
      filters.push({kind: 'expired-over-month', label: 'scaduti da più di un mese'})
    } else {
      filters.push({kind: 'expired', label: 'scaduti'})
    }

    return filters
  }

  if (
    dateRange &&
    !isExplicitSupplierExpiryRequest(message) &&
    /\b(scadenza|scadenze|scade|scadono|scadra|scadranno|rinnovo|rinnovi|rinnovano|termina|terminano)\b/.test(
      text
    )
  ) {
    filters.push({
      kind: 'expires-in-range',
      label: `con scadenza ${dateRange.label}`,
      dateRange,
    })

    return filters
  }

  if (
    /\b(rinnovi?\s+imminenti|in scadenza|scadenze|scadono|rinnovi? entro|entro analysis|analysisperiod)\b/.test(
      text
    )
  ) {
    filters.push({kind: 'expiring', label: 'con rinnovi imminenti'})
  }

  return filters
}

function detectScopedExpiryFilters(message = '') {
  const text = normalizeSearchText(message)
  const supplierYear = Number(
    text.match(/\bscadenz[ae]\s+(?:del\s+)?(?:fornitore|supplier|provider)\b.{0,30}?\b(20\d{2})\b/)?.[1]
  )
  const customerYear = Number(
    text.match(/\bscadenz[ae]\s+(?:del\s+)?cliente\b.{0,30}?\b(20\d{2})\b/)?.[1]
  )

  if (!Number.isFinite(supplierYear) || !Number.isFinite(customerYear)) return []

  return [
    {
      kind: 'supplier-expires-in-range',
      label: `con scadenza fornitore nel ${supplierYear}`,
      dateRange: {...buildYearRange(supplierYear), label: `nel ${supplierYear}`},
    },
    {
      kind: 'expires-in-range',
      label: `con scadenza cliente nel ${customerYear}`,
      dateRange: {...buildYearRange(customerYear), label: `nel ${customerYear}`},
    },
  ]
}

function filterService(service, filter, {settings, now}) {
  const analysisPeriod = Number(settings?.analysis_period ?? 30)
  const limitDate = new Date(now.getTime() + analysisPeriod * 864e5)
  const space = getServiceSpaceInfo(service, settings?.renewals_low_thresholds || [])
  const nextCustomerExpiry = getNextCustomerExpiry(service, now)
  const expiredCustomerExpiry = getExpiredCustomerExpiry(service, now)

  switch (filter.kind) {
    case 'space-full':
      return space.isFull
    case 'space-low':
      return space.isLow && !space.isFull
    case 'space-usage-gte':
      return space.quota > 0 && space.percent >= Number(filter.threshold)
    case 'operational-flags-any':
      return (filter.flags || []).some(kind => {
        if (kind === 'dont-renew') return isDontRenewService(service)
        if (kind === 'to-renew') return service?.toRenew === true || service?.to_renew === true
        if (kind === 'to-transfer') return Boolean(service?.toTransfer || service?.to_transfer)
        return false
      })
    case 'dont-renew':
      return isDontRenewService(service)
    case 'to-renew':
      return service?.toRenew === true || service?.to_renew === true
    case 'to-transfer':
      return Boolean(service?.toTransfer || service?.to_transfer)
    case 'auto-renew':
      return service?.autoRenew === true || service?.auto_renew === true
    case 'no-auto-renew':
      return service?.autoRenew !== true && service?.auto_renew !== true
    case 'no-plesk-sync':
      return service?.pleskPlansSync !== true && service?.plesk_plans_sync !== true
    case 'plesk-sync':
      return service?.pleskPlansSync === true || service?.plesk_plans_sync === true
    case 'has-plesk':
      return hasPleskDomain(service)
    case 'no-plesk':
      return !hasPleskDomain(service)
    case 'has-domain-record':
      return hasDomainRecord(service)
    case 'no-domain-record':
      return !hasDomainRecord(service)
    case 'missing-price':
      return hasMissingPrice(service)
    case 'billing': {
      const date = getInvoiceDate(service)
      if (!date) return false
      if (filter.dateRange) return isWithin(date, filter.dateRange)
      return service?.status === '1' || service?.status === 1 || service?.status == null
    }
    case 'has-auth-code':
      return Boolean(service?.authCode || service?.auth_code)
    case 'no-auth-code':
      return !service?.authCode && !service?.auth_code
    case 'has-communications':
      return (service?.renewalsCommunications || []).length > 0
    case 'no-communications':
      return (service?.renewalsCommunications || []).length === 0
    case 'has-traffic':
      return getServiceTraffic(service) > 0
    case 'expired':
      return Boolean(expiredCustomerExpiry)
    case 'expired-over-month': {
      const threshold = new Date(now.getTime() - 30 * 864e5)
      return Boolean(expiredCustomerExpiry && expiredCustomerExpiry < threshold)
    }
    case 'expiring':
      return Boolean(
        nextCustomerExpiry && nextCustomerExpiry >= now && nextCustomerExpiry <= limitDate
      )
    case 'expires-in-range':
      return hasCustomerExpiryWithin(service, filter.dateRange)
    case 'supplier-expires-in-range':
      return hasSupplierExpiryWithin(service, filter.dateRange)
    case 'plan':
      return hasMatchingPlan(service, filter.term)
    case 'service-type':
      return matchesServiceType(service, filter.term)
    case 'customer-or-group':
      return matchesCustomerOrGroup(service, filter.term)
    case 'exclude-customer-or-group':
      return !matchesCustomerOrGroup(service, filter.term)
    case 'supplier':
      return matchesSupplier(service, filter.term)
    case 'status':
      return includesText(service?.status, filter.term)
    default:
      return true
  }
}

function buildFilters({message, settings, now}) {
  const dateRange = extractDateRange(message, now)
  const scopedExpiryFilters = detectScopedExpiryFilters(message)
  const filters = [
    ...detectBooleanFilters(message),
    ...(scopedExpiryFilters.length
      ? scopedExpiryFilters
      : detectExpiryFilters(message, dateRange)),
  ]
  const text = normalizeSearchText(message)

  const planTerm = extractPlanTerm(message)
  if (planTerm) {
    filters.push({kind: 'plan', label: `con piano contenente "${planTerm}"`, term: planTerm})
  }

  const supplierTerm = extractSupplierTerm(message)
  if (/\b(fornitor[ei]|supplier|provider)\b/i.test(message)) {
    if (supplierTerm || !isExplicitSupplierExpiryRequest(message)) {
      filters.push({
        kind: 'supplier',
        label: supplierTerm ? `con fornitore contenente "${supplierTerm}"` : 'con fornitore',
        term: supplierTerm,
      })
    }
  }

  if (
    !scopedExpiryFilters.length &&
    dateRange &&
    /\b(fornitor[ei]|supplier|provider)\b/i.test(message) &&
    /\b(scadenza|scadenze|scade|scadono|scadra|scadranno)\b/.test(text)
  ) {
    filters.push({
      kind: 'supplier-expires-in-range',
      label: `con scadenza fornitore ${dateRange.label}`,
      dateRange,
    })
  }

  if (dateRange && /\b(fatturazione|fattura|invoice)\b/.test(text)) {
    const billingFilter = filters.find(item => item.kind === 'billing')
    if (billingFilter) {
      billingFilter.dateRange = dateRange
      billingFilter.label = `in fatturazione ${dateRange.label}`
    }
  }

  const serviceTypeTerm = extractServiceTypeTerm(message)
  if (serviceTypeTerm) {
    filters.push({
      kind: 'service-type',
      label: `di tipo "${serviceTypeTerm}"`,
      term: serviceTypeTerm,
    })
  }

  const customerOrGroupTerm = extractCustomerOrGroupTerm(message)
  if (customerOrGroupTerm) {
    filters.push({
      kind: 'customer-or-group',
      label: `di cliente/gruppo contenente "${customerOrGroupTerm}"`,
      term: customerOrGroupTerm,
    })
  }

  const customerOrGroupExclusion = extractCustomerOrGroupExclusion(message)
  if (customerOrGroupExclusion) {
    filters.push({
      kind: 'exclude-customer-or-group',
      label: `escludendo cliente/gruppo contenente "${customerOrGroupExclusion}"`,
      term: customerOrGroupExclusion,
    })
  }

  const status = message.match(/\b(?:stato|status)\s+([a-z0-9_-]{1,20})\b/i)
  if (status?.[1]) {
    filters.push({kind: 'status', label: `con stato "${status[1]}"`, term: status[1]})
  }

  if (!filters.length) {
    filters.push({kind: 'all', label: 'servizi'})
  }

  return filters
}

function describeFilters(filters = []) {
  if (!filters.length || (filters.length === 1 && filters[0].kind === 'all')) {
    return 'servizi'
  }

  return `servizi ${filters
    .map(filter => filter.label)
    .filter(Boolean)
    .join(', ')}`
}

function hasFilter(filters = [], ...kinds) {
  return filters.some(filter => kinds.includes(filter.kind))
}

function compareByCustomerAndName(a, b) {
  const ca = String(a?.customer?.name || '').localeCompare(String(b?.customer?.name || ''), 'it')
  if (ca !== 0) return ca

  return String(a?.name || '').localeCompare(String(b?.name || ''), 'it')
}

function getPriority(service, filters, settings, now) {
  const space = getServiceSpaceInfo(service, settings?.renewals_low_thresholds || [])
  const nextCustomerExpiry = getNextCustomerExpiry(service, now)
  const expiredCustomerExpiry = getExpiredCustomerExpiry(service, now)

  if (hasFilter(filters, 'space-full', 'space-usage-gte') && (space.isFull || space.percent > 0)) {
    return 'alta'
  }

  if (hasFilter(filters, 'expired', 'expired-over-month') && expiredCustomerExpiry) {
    return 'alta'
  }

  if (hasFilter(filters, 'expiring', 'expires-in-range') && nextCustomerExpiry) {
    const days = (nextCustomerExpiry.getTime() - now.getTime()) / 864e5

    if (days < 0 || days <= 7) return 'alta'
    return 'media'
  }

  if (hasFilter(filters, 'space-low') && space.isLow) {
    return 'media'
  }

  if (
    hasFilter(
      filters,
      'dont-renew',
      'to-renew',
      'to-transfer',
      'operational-flags-any',
      'no-plesk-sync',
      'missing-price',
      'billing'
    )
  ) {
    return 'media'
  }

  return 'bassa'
}

function buildReason(service, filters, settings, now) {
  const space = getServiceSpaceInfo(service, settings?.renewals_low_thresholds || [])
  const nextCustomerExpiry = getNextCustomerExpiry(service, now)
  const expiredCustomerExpiry = getExpiredCustomerExpiry(service, now)
  const supplierExpiryFilter = filters.find(filter => filter.kind === 'supplier-expires-in-range')
  const matchingSupplierExpiry = supplierExpiryFilter
    ? getSupplierSubscriptionDates(service).find(date => isWithin(date, supplierExpiryFilter.dateRange)) || null
    : null
  const parts = []

  for (const filter of filters) {
    if (filter.kind === 'all') continue

    if (filter.kind === 'space-full') parts.push(`spazio esaurito (${space.percent.toFixed(1)}%)`)
    else if (filter.kind === 'space-low')
      parts.push(`spazio in esaurimento (${space.percent.toFixed(1)}%)`)
    else if (filter.kind === 'space-usage-gte')
      parts.push(`spazio utilizzato ${space.percent.toFixed(1)}%`)
    else if (filter.kind === 'operational-flags-any')
      parts.push('corrisponde ad almeno uno dei flag richiesti')
    else if (filter.kind === 'expiring' && nextCustomerExpiry)
      parts.push(`scadenza ${formatDate(nextCustomerExpiry)}`)
    else if (filter.kind === 'expired' && expiredCustomerExpiry)
      parts.push(`scaduto il ${formatDate(expiredCustomerExpiry)}`)
    else if (filter.kind === 'expired-over-month' && expiredCustomerExpiry) {
      parts.push(`scaduto il ${formatDate(expiredCustomerExpiry)}`)
    } else if (filter.kind === 'expires-in-range')
      parts.push(`scadenza nel periodo ${filter.dateRange.label}`)
    else if (filter.kind === 'supplier-expires-in-range' && matchingSupplierExpiry)
      parts.push(`scadenza fornitore ${formatDate(matchingSupplierExpiry)}`)
    else if (filter.kind === 'no-auto-renew') parts.push('senza rinnovo automatico')
    else if (filter.kind === 'no-plesk-sync') parts.push('piani Plesk non sincronizzati')
    else if (filter.kind === 'plesk-sync') parts.push('piani Plesk sincronizzati')
    else if (filter.kind === 'missing-price') parts.push('prezzo mancante')
    else if (filter.kind === 'billing') parts.push('in fatturazione')
  }

  return parts.join('; ')
}

function buildServiceItem(service, {filters, settings, now}) {
  const space = getServiceSpaceInfo(service, settings?.renewals_low_thresholds || [])
  const nextCustomerExpiry = getNextCustomerExpiry(service, now)
  const expiredCustomerExpiry = getExpiredCustomerExpiry(service, now)
  const supplierDates = getSupplierSubscriptionDates(service)
  const supplierExpiryFilter = filters.find(filter => filter.kind === 'supplier-expires-in-range')
  const supplierExpiry = supplierExpiryFilter
    ? supplierDates.find(date => isWithin(date, supplierExpiryFilter.dateRange)) || null
    : supplierDates[0] || null
  const planFilter = filters.find(filter => filter.kind === 'plan')
  const matchedPlans = planFilter?.term ? getMatchingPlans(service, planFilter.term) : []
  const customerPlans = getCustomerPlanRefs(service)
  const displayPlans = (matchedPlans.length ? matchedPlans : customerPlans).slice(0, 5)
  const suppliers = [...new Set(getSupplierNames(service))]
  const lastCommunicationDate = getLastCommunicationDate(service)

  return {
    id: service?.id || null,
    servizio: service?.name || '—',
    dominio: getDomainName(service),
    cliente: service?.customer?.name || '—',
    customerId: service?.customer?.id || null,
    gruppo: service?.customer?.group?.name || null,
    groupId: service?.customer?.group?.id || null,
    status: service?.status ?? null,
    tipologie: getServiceTypeNames(service),
    piano: displayPlans[0]?.name || null,
    piani: displayPlans.map(plan => ({
      id: plan.id,
      name: plan.name,
      description: plan.description,
      source: plan.source,
      supplier: plan.supplier,
      missingPrice: plan.missingPrice,
    })),
    scadenza: nextCustomerExpiry ? nextCustomerExpiry.toISOString().split('T')[0] : null,
    scadenzaFormattata: nextCustomerExpiry ? formatDate(nextCustomerExpiry) : null,
    scadenzaScaduta: expiredCustomerExpiry
      ? expiredCustomerExpiry.toISOString().split('T')[0]
      : null,
    scadenzaFornitore: supplierExpiry ? supplierExpiry.toISOString().split('T')[0] : null,
    invoiceDate: getInvoiceDate(service)?.toISOString()?.split('T')?.[0] || null,
    autoRenew: service?.autoRenew === true || service?.auto_renew === true,
    dontRenew: service?.dontRenew === true || service?.dont_renew === true,
    toRenew: service?.toRenew === true || service?.to_renew === true,
    toTransfer: service?.toTransfer || service?.to_transfer || null,
    pleskPlansSync: service?.pleskPlansSync === true || service?.plesk_plans_sync === true,
    hasPlesk: hasPleskDomain(service),
    hasDomainRecord: hasDomainRecord(service),
    spazio: {
      used: space.used,
      quota: space.quota,
      percent: space.percent,
      isFull: space.isFull,
      isLow: space.isLow,
    },
    fornitori: suppliers,
    totalTraffic: getServiceTraffic(service),
    lastCommunicationDate: lastCommunicationDate?.toISOString?.() || null,
    priorita: getPriority(service, filters, settings, now),
    motivo: buildReason(service, filters, settings, now),
  }
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean).map(String))]
}

function getTransferKey(value) {
  if (!value) return ''
  if (typeof value === 'object') return value.id || value.name || JSON.stringify(value)
  return String(value)
}

function getServiceItemGroupKey(item = {}) {
  return [
    normalizeSearchText(item.servizio || ''),
    normalizeSearchText(item.cliente || ''),
    normalizeSearchText(item.gruppo || ''),
    normalizeSearchText(item.piano || ''),
    item.scadenza || '',
    item.scadenzaScaduta || '',
    item.scadenzaFornitore || '',
    item.autoRenew ? 'auto-renew' : '',
    item.dontRenew ? 'dont-renew' : '',
    item.toRenew ? 'to-renew' : '',
    getTransferKey(item.toTransfer),
  ].join('|')
}

function uniquePlanItems(plans = []) {
  const map = new Map()

  for (const plan of plans || []) {
    const key = [
      plan.id || '',
      normalizeSearchText(plan.name || ''),
      normalizeSearchText(plan.source || ''),
      normalizeSearchText(plan.supplier || ''),
      plan.missingPrice ? 'missing-price' : '',
    ].join('|')

    if (!map.has(key)) {
      map.set(key, plan)
    }
  }

  return [...map.values()]
}

function mergeServiceListItems(existing, item) {
  return {
    ...existing,
    count: existing.count + 1,
    ids: [...(existing.ids || []), item.id].filter(Boolean),
    tipologie: uniqueStrings([...(existing.tipologie || []), ...(item.tipologie || [])]),
    piani: uniquePlanItems([...(existing.piani || []), ...(item.piani || [])]),
    fornitori: uniqueStrings([...(existing.fornitori || []), ...(item.fornitori || [])]),
    autoRenew: existing.autoRenew || item.autoRenew,
    dontRenew: existing.dontRenew || item.dontRenew,
    toRenew: existing.toRenew || item.toRenew,
    toTransfer: existing.toTransfer || item.toTransfer,
  }
}

function groupServiceListItems(items = []) {
  const map = new Map()

  for (const item of items) {
    const key = getServiceItemGroupKey(item)
    const existing = map.get(key)

    if (existing) {
      map.set(key, mergeServiceListItems(existing, item))
    } else {
      map.set(key, {
        ...item,
        count: 1,
        ids: item.id ? [item.id] : [],
      })
    }
  }

  return [...map.values()]
}

function sortServices(services, filters, settings, now) {
  return [...services].sort((a, b) => {
    if (hasFilter(filters, 'space-full', 'space-low', 'space-usage-gte', 'has-traffic')) {
      const sa = getServiceSpaceInfo(a, settings?.renewals_low_thresholds || [])
      const sb = getServiceSpaceInfo(b, settings?.renewals_low_thresholds || [])

      if (sb.percent !== sa.percent) return sb.percent - sa.percent
    }

    if (hasFilter(filters, 'expired', 'expired-over-month')) {
      const da = getExpiredCustomerExpiry(a, now)
      const db = getExpiredCustomerExpiry(b, now)

      if (da && db) return da - db
      if (da) return -1
      if (db) return 1
    }

    if (hasFilter(filters, 'expiring', 'expires-in-range')) {
      const da = getNextCustomerExpiry(a, now)
      const db = getNextCustomerExpiry(b, now)

      if (da && db) return da - db
      if (da) return -1
      if (db) return 1
    }

    if (hasFilter(filters, 'billing')) {
      const da = getInvoiceDate(a)
      const db = getInvoiceDate(b)

      if (da && db) return da - db
      if (da) return -1
      if (db) return 1
    }

    if (hasFilter(filters, 'supplier', 'supplier-expires-in-range')) {
      const da = getSupplierSubscriptionDates(a)[0]
      const db = getSupplierSubscriptionDates(b)[0]

      if (da && db) return da - db
      if (da) return -1
      if (db) return 1
    }

    return compareByCustomerAndName(a, b)
  })
}

function applyScope(services = [], {customerId = null, groupId = null, serviceId = null} = {}) {
  let out = services

  if (serviceId) {
    out = out.filter(service => String(service?.id) === String(serviceId))
  }

  if (customerId) {
    out = out.filter(service => String(service?.customer?.id) === String(customerId))
  }

  if (groupId) {
    out = out.filter(service => String(service?.customer?.group?.id) === String(groupId))
  }

  return out
}

export function assessServiceListQuery({message = '', query = null} = {}) {
  const text = normalizeSearchText(message)
  const filters = Array.isArray(query?.filters) ? query.filters : []
  const activeFilters = filters.filter(filter => filter?.kind && filter.kind !== 'all')
  const warnings = []

  const scopeFilter = activeFilters.find(filter => filter.kind === 'customer-or-group')

  if (scopeFilter?.term && isOperationalScopeTerm(scopeFilter.term)) {
    warnings.push('operational-text-interpreted-as-customer-or-group')
  }

  const hasExplicitYear = /\b20\d{2}\b/.test(text)
  const hasExpiryLanguage =
    /\b(?:scadenza|scadenze|scade|scadono|scadra|scadranno|rinnovo|rinnovi|rinnovano|termina|terminano)\b/.test(
      text
    )
  const hasExpiryRange = activeFilters.some(filter =>
    ['expires-in-range', 'supplier-expires-in-range'].includes(filter.kind)
  )

  if (hasExplicitYear && hasExpiryLanguage && !hasExpiryRange) {
    warnings.push('explicit-year-without-expiry-range')
  }

  const supplierFilter = activeFilters.find(filter => filter.kind === 'supplier')

  if (supplierFilter?.term && isTemporalOrOperationalTerm(supplierFilter.term)) {
    warnings.push('temporal-text-interpreted-as-supplier')
  }

  if (
    isExplicitSupplierExpiryRequest(message) &&
    activeFilters.some(filter => filter.kind === 'expires-in-range') &&
    activeFilters.some(filter => filter.kind === 'supplier-expires-in-range')
  ) {
    warnings.push('supplier-expiry-also-interpreted-as-customer-expiry')
  }

  const hasOperationalFilterLanguage =
    /\b(?:rinnovi|scadenze|scade|scadono|scadra|scadranno|scaduti|imminenti|spazio|quota|plesk|fatturazione|fornitore|provider|supplier|piano|plan|non\s+rinnovare|da\s+rinnovare|da\s+trasferire)\b/.test(
      text
    )

  if (hasOperationalFilterLanguage && activeFilters.length === 0) {
    warnings.push('operational-list-without-filters')
  }

  return {
    valid: warnings.length === 0,
    warnings,
  }
}

export function parseServiceListQuery({
  message = '',
  paginationMessage = '',
  previousQuery = null,
  pagination = null,
  settings = {},
  now = new Date(),
} = {}) {
  if (previousQuery?.filters?.length) {
    return buildQueryFromPreviousState({
      previousQuery,
      pagination,
      fallbackMessage: message,
    })
  }

  const limitInfo = extractLimit(pagination ? message : paginationMessage || message)
  const filters = buildFilters({message, settings, now})
  const countOnly = !pagination && isCountOnlyRequest(message)

  if (pagination) {
    return {
      type: 'service-list-query',
      label: describeFilters(filters),
      filters,
      limit: clampLimit(pagination.limit, limitInfo.limit),
      offset: Math.max(Number(pagination.offset || 0), 0),
      requestedLimit: Boolean(pagination.limit),
      requestedAll: false,
      requestedMore: pagination.direction === 'next',
      requestedPrevious: pagination.direction === 'previous',
      requestedFirst: pagination.direction === 'first',
      countOnly: false,
      sourceMessage: compactText(message),
    }
  }

  return {
    type: 'service-list-query',
    label: describeFilters(filters),
    filters,
    limit: limitInfo.limit,
    offset: limitInfo.offset,
    requestedLimit: limitInfo.requestedLimit,
    requestedAll: limitInfo.requestedAll,
    requestedMore: limitInfo.requestedMore,
    requestedPrevious: false,
    requestedFirst: false,
    countOnly,
    sourceMessage: compactText(message),
  }
}

export function buildServiceListPayload({
  services = [],
  settings = {},
  message = '',
  paginationMessage = '',
  previousQuery = null,
  pagination = null,
  includeDontRenewOverride = null,
  customerId = null,
  groupId = null,
  serviceId = null,
  now = new Date(),
} = {}) {
  const query = parseServiceListQuery({
    message,
    paginationMessage,
    previousQuery,
    pagination,
    settings,
    now,
  })
  const explicitDontRenewMode =
    typeof includeDontRenewOverride === 'boolean'
      ? includeDontRenewOverride
      : getDontRenewInclusionMode(message)
  const scoped = applyScope(services, {customerId, groupId, serviceId})
  const includeDontRenew =
    typeof explicitDontRenewMode === 'boolean'
      ? explicitDontRenewMode
      : typeof query.includeDontRenew === 'boolean'
        ? query.includeDontRenew
        : shouldIncludeDontRenew({
            message,
            filters: query.filters,
            requestedAll: query.requestedAll,
          })

  const matchedBeforeDontRenewExclusion = scoped.filter(service => {
    return query.filters.every(filter => filterService(service, filter, {settings, now}))
  })

  const dontRenewMatches = matchedBeforeDontRenewExclusion.filter(isDontRenewService).length

  const matched = includeDontRenew
    ? matchedBeforeDontRenewExclusion
    : matchedBeforeDontRenewExclusion.filter(service => !isDontRenewService(service))

  const sorted = sortServices(matched, query.filters, settings, now)
  const rawItems = sorted.map(service =>
    buildServiceItem(service, {filters: query.filters, settings, now})
  )
  const groupedItems = groupServiceListItems(rawItems)
  const items = query.countOnly
    ? []
    : groupedItems.slice(query.offset, query.offset + query.limit)
  const hasMore = query.countOnly ? false : groupedItems.length > query.offset + items.length
  const previousOffset = query.offset > 0 ? Math.max(query.offset - query.limit, 0) : null
  const nextOffset = hasMore ? query.offset + items.length : null
  const emptySuggestion =
    matched.length === 0 &&
    includeDontRenew === false &&
    explicitDontRenewMode === null &&
    dontRenewMatches > 0
      ? {
          kind: 'include-dont-renew',
          count: dontRenewMatches,
        }
      : null

  return {
    type: 'service-list',
    scope: {
      customerId: customerId || null,
      groupId: groupId || null,
      serviceId: serviceId || null,
    },
    query: {
      label: query.label,
      includeDontRenew,
      excludedDontRenew:
        !includeDontRenew && (isOperationalQuery(query.filters) || explicitDontRenewMode === false),
      dontRenew: {
        explicitMode:
          typeof explicitDontRenewMode === 'boolean'
            ? explicitDontRenewMode
              ? 'include'
              : 'exclude'
            : null,
        matchedInRequest: dontRenewMatches,
        included: includeDontRenew,
        excludedCount: includeDontRenew ? 0 : dontRenewMatches,
      },
      suggestion: emptySuggestion,
      filters: query.filters.map(filter => ({
        kind: filter.kind,
        label: filter.label,
        term: filter.term || null,
        threshold: Number.isFinite(Number(filter.threshold)) ? Number(filter.threshold) : null,
        flags: Array.isArray(filter.flags) ? [...filter.flags] : null,
        dateRange: filter.dateRange
          ? {
              label: filter.dateRange.label,
              start: filter.dateRange.start.toISOString(),
              end: filter.dateRange.end.toISOString(),
            }
          : null,
      })),
      limit: query.limit,
      offset: query.offset,
      requestedLimit: query.requestedLimit,
      requestedAll: query.requestedAll,
      requestedMore: query.requestedMore,
      requestedPrevious: query.requestedPrevious,
      requestedFirst: query.requestedFirst === true,
      countOnly: query.countOnly === true,
      sourceMessage: query.sourceMessage,
    },
    totale: matched.length,
    groups: groupedItems.length,
    grouped: groupedItems.length !== rawItems.length,
    shown: items.length,
    page: Math.floor(query.offset / Math.max(query.limit, 1)) + 1,
    previousOffset,
    nextOffset,
    hasMore,
    truncated: hasMore,
    items,
  }
}
