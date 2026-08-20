import {normalizeSearchText} from '../../../utils/text.js'
import {
  extractEntityTarget,
  isOpenEntityRequest,
  resolveNamedEntity,
} from '../../../core/entities/entityResolver.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const ORDINALS = new Map([
  ['primo', 1],
  ['prima', 1],
  ['secondo', 2],
  ['seconda', 2],
  ['terzo', 3],
  ['terza', 3],
  ['quarto', 4],
  ['quarta', 4],
  ['quinto', 5],
  ['quinta', 5],
  ['sesto', 6],
  ['sesta', 6],
  ['settimo', 7],
  ['settima', 7],
  ['ottavo', 8],
  ['ottava', 8],
  ['nono', 9],
  ['nona', 9],
  ['decimo', 10],
  ['decima', 10],
])

const FILTER_LABELS = {
  all: 'webcam',
  online: 'webcam online',
  offline: 'webcam offline',
  'stream-offline': 'webcam con stream non online',
  'snapshot-offline': 'webcam con snapshot non online',
  'connectivity-offline': 'webcam con problemi di connettività',
  'mikrotik-offline': 'webcam con MikroTik non online',
  'in-use': 'webcam in uso',
  'not-in-use': 'webcam non in uso',
  vpn: 'webcam VPN',
  mikrotik: 'webcam con MikroTik',
  reseller: 'webcam reseller',
  encoding: 'webcam con encoding',
  monitored: 'webcam monitorate',
  unmonitored: 'webcam non monitorate',
  snapshot: 'webcam con snapshot abilitato',
  downtime: 'webcam con downtime programmato',
  'active-downtime': 'webcam attualmente in downtime programmato',
}

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const number = Number.parseInt(String(value ?? ''), 10)

  if (!Number.isFinite(number)) return fallback

  return Math.min(Math.max(number, 1), MAX_LIMIT)
}

function getHistoryContent(item = {}) {
  return String(item?.content || item?.message || item?.text || item?.reply || '').trim()
}

function getHistoryItemData(item = {}) {
  return item?.data || item?.payload || item?.response?.data || item?.result?.data || null
}

function contains(value, term) {
  const haystack = normalizeSearchText(value)
  const needle = normalizeSearchText(term)

  return Boolean(haystack && needle && haystack.includes(needle))
}

function cleanTerm(value = '') {
  return String(value || '')
    .replace(/[?.!,;:]+$/g, '')
    .replace(/^['"“”]+|['"“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanWebcamTarget(value = '') {
  let target = cleanTerm(value)

  const prefix = /^(?:(?:di|del|della|su|sulla|per)\s+)?(?:(?:questa|quella|la|il|una)\s+)?(?:webcam|telecamera)\s*/i
  for (let pass = 0; pass < 3; pass += 1) {
    const next = target.replace(prefix, '').trim()
    if (next === target) break
    target = next
  }

  return /^(?:questa|quella|la|il|essa|questa\s+qui)$/i.test(target) ? '' : target
}

function stripKnownFilterTail(value = '') {
  return cleanTerm(value)
    .replace(
      /\b(?:online|offline|in uso|non in uso|vpn|mikrotik|reseller|con encoding|monitorat[ei]|non monitorat[ei]|con snapshot|snapshot (?:blocc|ferm|congel)|downtime|spegnimento programmato)\b.*$/i,
      ''
    )
    .replace(/\b(?:sono|risultano|hanno|ha|che)\s*$/i, '')
    .trim()
}

function isReservedSearchTerm(value = '') {
  const text = normalizeSearchText(value)

  return /^(online|offline|vpn|mikrotik|reseller|encoding|monitorate|monitorati|non monitorate|non monitorati|in uso|non in uso|stream|snapshot|connettivita|router|downtime|tutte|tutti)$/.test(
    text
  )
}

function extractLimit(message = '') {
  const text = normalizeSearchText(message)
  const match = text.match(
    /\b(?:mostrami|mostra|dammi|elenca|elencami|fammi vedere|primi|prime|altri|altre|prossimi|prossime|successivi|successive)\s+(\d{1,2})\b/i
  )

  if (match?.[1]) return clampLimit(match[1])

  const itemCount = text.match(/\b(\d{1,2})\s+(?:webcam|risultati|voci)\b/i)

  return itemCount?.[1] ? clampLimit(itemCount[1]) : DEFAULT_LIMIT
}

export function parsePaginationRequest(message = '') {
  const text = normalizeSearchText(message)

  if (!text) return null

  const limit = extractLimit(text)

  if (
    /\b(?:precedenti|precedente|indietro|torna indietro|pagina precedente)\b/i.test(text)
  ) {
    return {direction: 'previous', limit}
  }

  if (
    /\b(?:primi|prime|dall inizio|dall'inizio|torna all inizio|torna all'inizio|prima pagina)\b/i.test(
      text
    )
  ) {
    return {direction: 'first', limit}
  }

  if (
    /\b(?:altri|altre|prossimi|prossime|successivi|successive|continua|prosegui|vai avanti|ancora|pagina successiva)\b/i.test(
      text
    )
  ) {
    return {direction: 'next', limit}
  }

  return null
}

function parseFilters(message = '') {
  const text = normalizeSearchText(message)
  const filters = []

  if (/\bstream\b.{0,30}\b(offline|non online|non funziona|non attivo|ko)\b/i.test(text)) {
    filters.push('stream-offline')
  }

  if (
    /\bsnapshot\b.{0,40}\b(offline|non online|non funziona|non attiv[oa]|ko|bloccat[oaie]*|ferm[oaie]*|congelat[oaie]*|non si aggiorna|non aggiornato)\b/i.test(text) ||
    /\b(offline|non online|bloccat[oaie]*|ferm[oaie]*|congelat[oaie]*)\b.{0,20}\bsnapshot\b/i.test(text)
  ) {
    filters.push('snapshot-offline')
  }

  if (
    /\b(connettivita|router|connessione)\b.{0,30}\b(offline|non risponde|irraggiungibile|problemi|ko)\b/i.test(
      text
    )
  ) {
    filters.push('connectivity-offline')
  }

  if (/\bmikrotik\b.{0,30}\b(offline|non risponde|irraggiungibile|problemi|ko)\b/i.test(text)) {
    filters.push('mikrotik-offline')
  }

  if (/\b(non in uso|fuori uso|disattivate|disattivi)\b/i.test(text)) {
    filters.push('not-in-use')
  } else if (/\b(in uso|attive|attivi)\b/i.test(text)) {
    filters.push('in-use')
  }

  if (/\b(non monitorate|non monitorati|senza monitoraggio)\b/i.test(text)) {
    filters.push('unmonitored')
  } else if (/\b(monitorate|monitorati|con monitoraggio)\b/i.test(text)) {
    filters.push('monitored')
  }

  if (/\b(downtime attivo|spegnimento attivo|attualmente spente per pianificazione)\b/i.test(text)) {
    filters.push('active-downtime')
  } else if (
    /\b(downtime|spegnimento programmato|spegnimenti programmati|pianificazione|pianificazioni)\b/i.test(
      text
    )
  ) {
    filters.push('downtime')
  }

  if (/\breseller\b/i.test(text)) filters.push('reseller')
  if (/\bencoding\b/i.test(text)) filters.push('encoding')
  if (/\b(vpn)\b/i.test(text)) filters.push('vpn')
  if (/\bmikrotik\b/i.test(text) && !filters.includes('mikrotik-offline')) filters.push('mikrotik')

  if (/\b(snapshot abilitato|snapshot abilitate|con snapshot)\b/i.test(text)) {
    filters.push('snapshot')
  }

  if (hasGenericOfflineMention(text)) {
    filters.push('offline')
  } else if (/\bonline\b/i.test(text) && !/\bnon online\b/i.test(text)) {
    filters.push('online')
  }

  const genericStoppedWebcam =
    (/\b(?:webcam|telecamer[ae])\b.{0,60}\b(?:ferm[ae]|blocc[ae]|guast[ae]|ko|non\s+funzionant[ei])\b/i.test(text) ||
      /\b(?:ferm[ae]|blocc[ae]|guast[ae]|ko|non\s+funzionant[ei])\b.{0,60}\b(?:webcam|telecamer[ae])\b/i.test(text)) &&
    !/\b(?:stream|snapshot|router|connettivita|mikrotik)\b/i.test(text)

  if (genericStoppedWebcam) filters.push('offline')

  return [...new Set(filters)]
}

function hasGenericOfflineMention(text = '') {
  for (const match of String(text).matchAll(/\boffline\b/gi)) {
    const prefix = String(text).slice(Math.max(0, match.index - 35), match.index)

    if (!/\b(?:stream|snapshot|connettivita|router|mikrotik)\b[^,.!?;]{0,30}$/i.test(prefix)) {
      return true
    }
  }

  return false
}

function extractSearchTerm(message = '') {
  const original = String(message || '').trim()
  const quoted = original.match(/["“”']([^"“”']{2,})["“”']/)

  if (quoted?.[1]) return cleanTerm(quoted[1])

  const patterns = [
    /\b(?:cerca|trova|cercami|trovami)\s+(?:la\s+|le\s+)?(?:webcam\s+)?(.+)$/i,
    /\b(?:webcam)\s+(?:di|del|della|a|in)\s+(.+?)(?=\s+(?:sono|risultano|hanno|ha|che|con|senza|offline|online)\b|[?.!,;:]|$)/i,
    /\b(?:webcam)\s+(?:di|del|della|a|in|chiamata|chiamate)\s+(.+)$/i,
    /\b(?:dettagli|dettaglio|scheda|informazioni|info)\s+(?:di|su|della|del)?\s*(.+)$/i,
  ]

  for (const pattern of patterns) {
    const match = original.match(pattern)
    const term = stripKnownFilterTail(match?.[1])

    if (term && !isReservedSearchTerm(term)) return term
  }

  const normalized = normalizeSearchText(original)
  const words = normalized.split(/\s+/).filter(Boolean)

  if (
    words.length >= 1 &&
    words.length <= 6 &&
    !/[?]/.test(original) &&
    !parseFilters(original).length &&
    !/\b(?:webcam|stream|snapshot|mikrotik|router|vpn|reseller|encoding|monitoraggio|downtime)\b/i.test(
      normalized
    ) &&
    !isReservedSearchTerm(normalized)
  ) {
    return cleanTerm(original)
  }

  return null
}

function describeQuery(filters = [], term = null, filterMode = 'all') {
  const parts = filters.map(filter => FILTER_LABELS[filter]).filter(Boolean)
  const base = parts.length ? parts.join(filterMode === 'any' ? ' oppure ' : ', ') : FILTER_LABELS.all

  return term ? `${base} corrispondenti a "${term}"` : base
}

export function parseListQuery(message = '', previousQuery = null, pagination = null) {
  if (previousQuery && pagination) {
    const limit = clampLimit(pagination.limit, previousQuery.limit || DEFAULT_LIMIT)
    const currentOffset = Number(previousQuery.offset || 0)
    const shown = Number(previousQuery.shown || previousQuery.limit || limit)

    let offset = currentOffset

    if (pagination.direction === 'first') offset = 0
    if (pagination.direction === 'previous') offset = Math.max(currentOffset - limit, 0)
    if (pagination.direction === 'next') offset = currentOffset + shown

    return {
      ...previousQuery,
      limit,
      offset,
      sourceMessage: previousQuery.sourceMessage || String(message || '').trim(),
    }
  }

  const filters = parseFilters(message)
  const term = extractSearchTerm(message)
  const limit = extractLimit(message)
  const filterMode = filters.length > 1 && /\b(?:o|oppure)\b/i.test(normalizeSearchText(message))
    ? 'any'
    : 'all'

  return {
    type: 'webcam-list-query',
    filters,
    filterMode,
    term,
    label: describeQuery(filters, term, filterMode),
    includeStatusSince: /\b(?:da\s+quando|da\s+quanto(?:\s+tempo)?)\b/i.test(
      normalizeSearchText(message)
    ),
    limit,
    offset: 0,
    sourceMessage: String(message || '').trim(),
  }
}

function matchesFilters(webcam, filters = [], filterMode = 'all') {
  const matches = filter => {
    switch (filter) {
      case 'online':
        return webcam.status.overall === 'online'
      case 'offline':
        return webcam.status.overall !== 'online'
      case 'stream-offline':
        return webcam.status.stream.status !== 'online'
      case 'snapshot-offline':
        return webcam.snapshotEnabled && webcam.status.snapshot.status !== 'online'
      case 'connectivity-offline':
        return (
          webcam.connectivityTestReachable === false ||
          (webcam.status.connectivity.status && webcam.status.connectivity.status !== 'online')
        )
      case 'mikrotik-offline':
        return webcam.hasMikrotik && webcam.status.mikrotik.status !== 'online'
      case 'in-use':
        return webcam.inUse
      case 'not-in-use':
        return !webcam.inUse
      case 'vpn':
        return webcam.vpn
      case 'mikrotik':
        return webcam.hasMikrotik
      case 'reseller':
        return Boolean(webcam.reseller)
      case 'encoding':
        return webcam.hasEncoding
      case 'monitored':
        return webcam.monitoring.any
      case 'unmonitored':
        return !webcam.monitoring.any
      case 'snapshot':
        return webcam.snapshotEnabled
      case 'downtime':
        return webcam.downtime.configured
      case 'active-downtime':
        return webcam.downtime.active
      default:
        return true
    }
  }

  return filterMode === 'any' ? filters.some(matches) : filters.every(matches)
}

function matchesTerm(webcam, term = null) {
  if (!term) return true

  return [
    webcam.name,
    webcam.slug,
    webcam.location,
    webcam.reseller,
    webcam.networkProvider,
    webcam.hardware?.brand,
    webcam.hardware?.model,
  ].some(value => contains(value, term))
}

function sortWebcams(items = []) {
  return [...items].sort((a, b) => {
    const resellerDiff = String(a.reseller || '').localeCompare(String(b.reseller || ''), 'it')
    if (resellerDiff !== 0) return resellerDiff
    if (a.inUse !== b.inUse) return a.inUse ? -1 : 1

    return String(a.name || '').localeCompare(String(b.name || ''), 'it')
  })
}

function toListItem(webcam = {}) {
  return {
    id: webcam.id,
    name: webcam.name,
    slug: webcam.slug,
    location: webcam.location,
    reseller: webcam.reseller,
    networkProvider: webcam.networkProvider,
    inUse: webcam.inUse,
    snapshotEnabled: webcam.snapshotEnabled,
    hasEncoding: webcam.hasEncoding,
    vpn: webcam.vpn,
    hasMikrotik: webcam.hasMikrotik,
    monitored: webcam.monitoring.any,
    monitoring: webcam.monitoring,
    status: webcam.status,
    downtime: {
      configured: webcam.downtime.configured,
      enabledCount: webcam.downtime.enabledCount,
      active: webcam.downtime.active,
      activeSchedule: webcam.downtime.activeSchedule,
    },
  }
}

export function buildWebcamListPayload({webcams = [], query = {}} = {}) {
  const filtered = sortWebcams(
    webcams.filter(webcam => matchesFilters(webcam, query.filters, query.filterMode))
  )
    .filter(webcam => matchesTerm(webcam, query.term))

  const offset = Math.max(Number(query.offset || 0), 0)
  const limit = clampLimit(query.limit, DEFAULT_LIMIT)
  const page = filtered.slice(offset, offset + limit)
  const shown = page.length

  return {
    type: 'webcam-list',
    query: {
      ...query,
      offset,
      limit,
      shown,
    },
    totale: filtered.length,
    shown,
    hasMore: offset + shown < filtered.length,
    nextOffset: offset + shown,
    previousOffset: offset > 0 ? Math.max(offset - limit, 0) : null,
    items: page.map((webcam, index) => ({
      ...toListItem(webcam),
      position: offset + index + 1,
    })),
  }
}

export function buildWebcamSummaryPayload(webcams = []) {
  const count = predicate => webcams.filter(predicate).length

  return {
    type: 'webcam-summary',
    summary: {
      total: webcams.length,
      inUse: count(webcam => webcam.inUse),
      online: count(webcam => webcam.status.overall === 'online'),
      offline: count(webcam => webcam.status.overall !== 'online'),
      streamOffline: count(webcam => webcam.status.stream.status !== 'online'),
      snapshotOffline: count(
        webcam => webcam.snapshotEnabled && webcam.status.snapshot.status !== 'online'
      ),
      connectivityProblems: count(
        webcam =>
          webcam.connectivityTestReachable === false ||
          (webcam.status.connectivity.status && webcam.status.connectivity.status !== 'online')
      ),
      mikrotikOffline: count(
        webcam => webcam.hasMikrotik && webcam.status.mikrotik.status !== 'online'
      ),
      vpn: count(webcam => webcam.vpn),
      reseller: count(webcam => Boolean(webcam.reseller)),
      encoding: count(webcam => webcam.hasEncoding),
      monitored: count(webcam => webcam.monitoring.any),
      scheduledDowntime: count(webcam => webcam.downtime.configured),
      activeDowntime: count(webcam => webcam.downtime.active),
    },
  }
}

function parsePositionSelector(message = '') {
  const text = normalizeSearchText(message)

  if (/\bpenultima\b|\bpenultimo\b/i.test(text)) return {kind: 'position', position: 'penultimate'}
  if (/\bultima\b|\bultimo\b/i.test(text)) return {kind: 'position', position: 'last'}

  for (const [word, position] of ORDINALS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) {
      return {kind: 'position', position}
    }
  }

  const numeric = text.match(/\b(?:numero|n\.?|riga|posizione|la|il)?\s*(\d{1,2})(?:\s*[°º])?\b/i)

  if (!numeric?.[1]) return null

  const position = Number(numeric[1])

  return position > 0 ? {kind: 'position', position, absolute: true} : null
}

function parseTextSelector(message = '') {
  const original = String(message || '')
  const match = original.match(
    /\b(?:quella|quello|questa|questo)\s+(?:di|del|della|a|in|con|contenente)\s+(.+)$/i
  )
  const term = cleanTerm(match?.[1])

  return term ? {kind: 'text', term} : null
}

export function parseReferenceRequest(message = '', {hasPreviousList = false} = {}) {
  if (!hasPreviousList) return null

  const text = normalizeSearchText(message)
  const selector = parsePositionSelector(message) || parseTextSelector(message)

  if (!selector) return null

  const explicitDetail = /\b(dettagli|dettaglio|scheda|informazioni|info|approfondisci|mostrami|dammi|dimmi|apri|aprimi|visualizza)\b/i.test(
    text
  )
  const conciseReference = /^(?:e\s+)?(?:(?:la|il|l')\s*)?(?:prima|primo|seconda|secondo|terza|terzo|ultima|ultimo|penultima|penultimo|numero\s+\d+|\d+|quella|quello|questa|questo)/i.test(
    text
  )

  return explicitDetail || conciseReference ? {selector} : null
}

function itemSearchScore(item = {}, term = '') {
  const fields = [
    {value: item.name, weight: 10},
    {value: item.slug, weight: 10},
    {value: item.location, weight: 6},
    {value: item.reseller, weight: 4},
    {value: item.networkProvider, weight: 3},
  ]
  const needle = normalizeSearchText(term)

  return fields.reduce((best, field) => {
    const value = normalizeSearchText(field.value)
    let score = 0

    if (value && needle) {
      if (value === needle) score = 100 + field.weight
      else if (value.startsWith(needle)) score = 80 + field.weight
      else if (value.includes(needle)) score = 60 + field.weight
    }

    return Math.max(best, score)
  }, 0)
}

export function resolveReference(request, previousList) {
  const items = previousList?.items || []
  const selector = request?.selector

  if (!selector) return {status: 'not-applicable'}
  if (!items.length) return {status: 'empty-list'}

  if (selector.kind === 'position') {
    if (selector.absolute) {
      const index = items.findIndex(item => Number(item.position) === Number(selector.position))

      if (index < 0) {
        return {
          status: 'out-of-range',
          available: items.length,
          firstPosition: items[0]?.position || 1,
          lastPosition: items.at(-1)?.position || items.length,
        }
      }

      return {status: 'resolved', item: items[index], index}
    }

    const index =
      selector.position === 'last'
        ? items.length - 1
        : selector.position === 'penultimate'
          ? items.length - 2
          : Number(selector.position) - 1

    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
      return {status: 'out-of-range', available: items.length}
    }

    return {status: 'resolved', item: items[index], index}
  }

  const candidates = items
    .map((item, index) => ({item, index, score: itemSearchScore(item, selector.term)}))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)

  if (!candidates.length) return {status: 'not-found', term: selector.term}

  const best = candidates.filter(candidate => candidate.score === candidates[0].score)

  if (best.length > 1) return {status: 'ambiguous', term: selector.term, candidates: best}

  return {status: 'resolved', item: best[0].item, index: best[0].index}
}

export function pickPreviousWebcamList(history = []) {
  const items = Array.isArray(history) ? [...history].reverse() : []

  for (const item of items) {
    if (item?.role !== 'assistant') continue

    const data = getHistoryItemData(item)

    if (data?.type === 'webcam-list') return data
  }

  return null
}

export function pickPreviousWebcamTarget(history = []) {
  const items = Array.isArray(history) ? [...history].reverse() : []

  for (const historyItem of items) {
    if (historyItem?.role !== 'assistant') continue

    const data = getHistoryItemData(historyItem)
    const item = data?.item || data?.entity

    if (data?.type === 'webcam-detail' && item) return item.slug || item.id || item.name || null
    if (data?.type === 'app-action' && data?.entity?.type === 'webcam') {
      return data.entity.slug || data.entity.id || data.entity.name || null
    }
  }

  return null
}

const ITALIAN_NUMBERS = new Map([
  ['un', 1], ['uno', 1], ['una', 1], ['due', 2], ['tre', 3], ['quattro', 4],
  ['cinque', 5], ['sei', 6], ['sette', 7], ['otto', 8], ['nove', 9], ['dieci', 10],
  ['dodici', 12], ['ventiquattro', 24], ['trenta', 30],
])

function parseNumber(value = '') {
  const normalized = normalizeSearchText(value)
  if (/^\d+$/.test(normalized)) return Number(normalized)
  return ITALIAN_NUMBERS.get(normalized) || null
}

function subtractCalendarMonth(date) {
  const copy = new Date(date)
  copy.setMonth(copy.getMonth() - 1)
  return copy
}

export function parseWebcamHistoryRequest(message = '', now = new Date()) {
  const text = normalizeSearchText(message)

  if (/\bultim[oa]\b.{0,30}\b(?:stato|evento|volta)?\s*(?:offline|non online|fuori linea)\b/i.test(text)) {
    const explicitTarget = String(message).match(
      /\b(?:offline|non online|fuori linea)\b[\s\S]*?\b(?:di|della|del)\s+(?:webcam\s+)?(.+)$/i
    )?.[1]

    return {
      type: 'latest-offline',
      target: cleanWebcamTarget(explicitTarget) || null,
    }
  }

  const duration = text.match(
    /\b(?:piu di|oltre|almeno)\s+(\d+|un[oa]?|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|dodici|ventiquattro|trenta)\s*(minut[oi]|or[ae]|giorn[oi])\b/i
  )
  if (!duration || !/\b(?:offline|non online|fuori linea)\b/i.test(text)) return null

  const amount = parseNumber(duration[1])
  const unit = duration[2]
  if (!amount) return null

  const minimumDurationMs = amount * (
    unit.startsWith('minut') ? 60 * 1000 : unit.startsWith('giorn') ? DAY_MS : HOUR_MS
  )
  let since = subtractCalendarMonth(now)

  const days = text.match(/\bultim[oi]\s+(\d+|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|trenta)\s+giorni\b/i)
  if (days?.[1]) since = new Date(now.getTime() - parseNumber(days[1]) * DAY_MS)
  else if (/\bultim[oa]\s+settiman[ae]\b/i.test(text)) since = new Date(now.getTime() - 7 * DAY_MS)
  else if (/\bultim[aei]\s+24\s+or[ae]\b/i.test(text)) since = new Date(now.getTime() - DAY_MS)

  const spanMs = Math.max(now.getTime() - since.getTime(), DAY_MS)

  return {
    type: 'outage-duration',
    statusType: 'stream',
    minimumDurationMs,
    since,
    fetchSince: new Date(since.getTime() - spanMs),
    limit: extractLimit(message),
  }
}

export function buildWebcamOutagePayload({webcams = [], logs = [], request = {}, now = new Date()} = {}) {
  const sinceMs = new Date(request.since).getTime()
  const nowMs = new Date(now).getTime()
  const minimumDurationMs = Number(request.minimumDurationMs || 0)
  const logsByWebcam = new Map()

  for (const log of logs) {
    if (!log?.webcamId || log.type !== request.statusType) continue
    const bucket = logsByWebcam.get(String(log.webcamId)) || []
    bucket.push(log)
    logsByWebcam.set(String(log.webcamId), bucket)
  }

  const matches = []
  for (const webcam of webcams) {
    const webcamLogs = (logsByWebcam.get(String(webcam.id)) || [])
      .filter(log => Number.isFinite(new Date(log.changedOn).getTime()))
      .sort((left, right) => new Date(left.changedOn) - new Date(right.changedOn))

    if (
      webcam.status?.stream?.status &&
      webcam.status.stream.status !== 'online' &&
      webcam.status.stream.changedOn &&
      !webcamLogs.some(log => log.changedOn === webcam.status.stream.changedOn)
    ) {
      webcamLogs.push({
        webcamId: webcam.id,
        type: request.statusType,
        status: webcam.status.stream.status,
        changedOn: webcam.status.stream.changedOn,
      })
      webcamLogs.sort((left, right) => new Date(left.changedOn) - new Date(right.changedOn))
    }

    const outages = []
    for (let index = 0; index < webcamLogs.length; index += 1) {
      const log = webcamLogs[index]
      if (!log.status || log.status === 'online') continue

      const startMs = Math.max(new Date(log.changedOn).getTime(), sinceMs)
      const nextMs = webcamLogs[index + 1]
        ? new Date(webcamLogs[index + 1].changedOn).getTime()
        : nowMs
      const endMs = Math.min(nextMs, nowMs)
      const durationMs = Math.max(0, endMs - startMs)

      if (endMs > sinceMs && durationMs >= minimumDurationMs) {
        outages.push({
          status: log.status,
          startedAt: new Date(startMs).toISOString(),
          endedAt: endMs >= nowMs ? null : new Date(endMs).toISOString(),
          durationMs,
        })
      }
    }

    if (!outages.length) continue

    const longestDurationMs = Math.max(...outages.map(item => item.durationMs))
    matches.push({...toListItem(webcam), outages, longestDurationMs})
  }

  matches.sort((left, right) => right.longestDurationMs - left.longestDurationMs)
  const limit = clampLimit(request.limit, DEFAULT_LIMIT)

  return {
    type: 'webcam-outage-history',
    since: new Date(sinceMs).toISOString(),
    minimumDurationMs,
    totale: matches.length,
    shown: Math.min(matches.length, limit),
    items: matches.slice(0, limit),
  }
}

export function buildLatestOfflinePayload({webcams = [], logs = [], target = null} = {}) {
  const detail = buildWebcamDetailPayload({webcams, target})
  if (detail.type !== 'webcam-detail') return {...detail, requestedType: 'latest-offline'}

  const item = detail.item
  const latest = logs
    .filter(log => String(log.webcamId) === String(item.id) && log.status && log.status !== 'online')
    .sort((left, right) => new Date(right.changedOn) - new Date(left.changedOn))[0] || null

  return {
    type: 'webcam-latest-offline',
    item,
    event: latest,
  }
}

export function buildWebcamDetailPayload({webcams = [], target = null} = {}) {
  const resolution = resolveNamedEntity({
    items: webcams,
    query: target,
    fields: [
      {value: 'slug', weight: 18},
      {value: 'name', weight: 16},
      {value: 'location', weight: 8},
      {value: 'reseller', weight: 4},
      {value: 'networkProvider', weight: 2},
      {value: webcam => webcam.hardware?.brand, weight: 1},
      {value: webcam => webcam.hardware?.model, weight: 1},
    ],
  })

  if (resolution.status === 'missing-target' || resolution.status === 'not-found') {
    return {
      type: 'webcam-detail-not-found',
      target,
      items: [],
    }
  }

  if (resolution.status === 'ambiguous') {
    return {
      type: 'webcam-detail-ambiguous',
      target,
      items: resolution.candidates.map((candidate, index) => ({
        ...toListItem(candidate.item),
        position: index + 1,
        matchScore: candidate.score,
      })),
    }
  }

  const webcam = resolution.item

  return {
    type: 'webcam-detail',
    item: {
      ...toListItem(webcam),
      installedOn: webcam.installedOn,
      createdOn: webcam.createdOn,
      hardware: webcam.hardware,
      downtime: webcam.downtime,
    },
  }
}

export function extractDetailTarget(message = '') {
  const quoted = String(message || '').match(/["“”']([^"“”']{2,})["“”']/)

  if (quoted?.[1]) return cleanWebcamTarget(quoted[1])

  const match = String(message || '').match(
    /\b(?:dettagli|dettaglio|scheda|informazioni|info|stat[oi]|situazione|come\s+sta|approfondisci|analizza|controlla|verifica)\s+(?:di|su|della|del|per)?\s*(.+)$/i
  )

  const statusSubject = String(message || '').match(
    /\b(?:stream|snapshot|connettivit[aà]|router|mikrotik)\b[\s\S]*?\b(?:di|della|del|su|sulla)\s+(.+)$/i
  )

  return (
    cleanWebcamTarget(match?.[1]) ||
    cleanWebcamTarget(statusSubject?.[1]) ||
    cleanWebcamTarget(extractEntityTarget(message)) ||
    null
  )
}

export function detectIntent(message = '', {previousList = null, hasActiveEntity = false, historyRequest = null} = {}) {
  const text = normalizeSearchText(message)

  if (/^(?:ciao|buongiorno|buonasera|salve|hey|ehi)[!,.]?$/i.test(text)) return 'greeting'

  if (
    /\b(riavvia|reboot|spegni|accendi|attiva|disattiva|modifica|imposta|configura|elimina|cancella|crea|duplica)\b/i.test(
      text
    )
  ) {
    return 'unsupported-action'
  }

  if (parsePaginationRequest(message)) return 'webcam-list-pagination'
  if (parseReferenceRequest(message, {hasPreviousList: Boolean(previousList)})) return 'webcam-reference'
  if (historyRequest?.type === 'latest-offline') return 'webcam-latest-offline'
  if (historyRequest?.type === 'outage-duration') return 'webcam-outage-history'

  if (isOpenEntityRequest(message)) return 'webcam-open'

  if (
    hasActiveEntity &&
    /\b(?:stream|snapshot|connettivit[aà]|router|mikrotik|vpn|encoding|hardware|monitoraggio|downtime)\b/i.test(text) &&
    !/\b(?:quali|elenca|elencami|lista|tutte|tutti|webcam\s+(?:con|che))\b/i.test(text)
  ) {
    return 'webcam-detail'
  }

  if (
    /\b(dettagli|dettaglio|scheda|informazioni|info|stat[oi]|come\s+sta|funziona|problemi?|approfondisci|analizza|controlla|verifica)\b/i.test(
      text
    )
  ) {
    return 'webcam-detail'
  }

  if (/\b(riepilogo|riassunto|panoramica|situazione|stato generale|come siamo messi)\b/i.test(text)) {
    return 'webcam-summary'
  }

  if (
    parseFilters(message).length ||
    extractSearchTerm(message) ||
    /\b(webcam|stream|snapshot|mikrotik|router|vpn|reseller|encoding|monitorat|downtime|connettivita)\b/i.test(
      text
    ) ||
    /\b(cerca|trova|cercami|trovami|elenca|elencami|mostra|mostrami|quali|dammi|fammi vedere)\b/i.test(
      text
    )
  ) {
    return 'webcam-list'
  }

  return 'clarification'
}
