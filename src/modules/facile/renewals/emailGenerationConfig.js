import {normalizeSearchText} from '../../../utils/text.js'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i
const MAX_ANALYSIS_PERIOD_DAYS = 730

const MONTHS = new Map([
  ['gennaio', 1],
  ['febbraio', 2],
  ['marzo', 3],
  ['aprile', 4],
  ['maggio', 5],
  ['giugno', 6],
  ['luglio', 7],
  ['agosto', 8],
  ['settembre', 9],
  ['ottobre', 10],
  ['novembre', 11],
  ['dicembre', 12],
])

const BOOLEAN_FIELDS = [
  'showAllServices',
  'includeDomainRegistrationUsage',
  'showPleskAddons',
  'showAutoRenewServices',
  'hideUsageDetails',
  'hideDiscountDetails',
  'limitFullSpaceToPeriod',
  'includeFutureLowSpace',
  'showRecentlyContacted',
  'hideRecentlyCommunicatedUpgrades',
  'testMode',
]

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function lastPatternIndex(text = '', pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const matcher = new RegExp(pattern.source, flags)
  let lastIndex = -1
  let match

  while ((match = matcher.exec(text))) {
    lastIndex = match.index
    if (match[0].length === 0) matcher.lastIndex += 1
  }

  return lastIndex
}

function setBooleanFromPatterns(target, field, text, positive = [], negative = []) {
  const matches = [
    ...positive.map(pattern => ({value: true, index: lastPatternIndex(text, pattern)})),
    ...negative.map(pattern => ({value: false, index: lastPatternIndex(text, pattern)})),
  ]
    .filter(item => item.index >= 0)
    .sort((a, b) => a.index - b.index)

  if (matches.length) target[field] = matches[matches.length - 1].value
}

function startOfUtcDay(value = new Date()) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function isoDateFromParts(day, month, year, now = new Date()) {
  const d = Number(day)
  const m = Number(month)
  let y = year == null ? null : Number(year)

  if (!Number.isInteger(d) || !Number.isInteger(m) || d < 1 || d > 31 || m < 1 || m > 12) {
    return null
  }

  const nowDate = new Date(now)
  if (Number.isNaN(nowDate.getTime())) return null

  if (!Number.isInteger(y)) {
    y = nowDate.getUTCFullYear()
    const candidate = Date.UTC(y, m - 1, d)
    if (candidate <= startOfUtcDay(nowDate)) y += 1
  }

  if (y < 100) y += 2000

  const candidate = new Date(Date.UTC(y, m - 1, d))
  if (
    candidate.getUTCFullYear() !== y ||
    candidate.getUTCMonth() !== m - 1 ||
    candidate.getUTCDate() !== d
  ) {
    return null
  }

  return candidate.toISOString().slice(0, 10)
}

function analysisDaysFromDate(isoDate, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ''))) return null

  const target = Date.parse(`${isoDate}T00:00:00.000Z`)
  const today = startOfUtcDay(now)
  if (!Number.isFinite(target) || today == null) return null

  return Math.ceil((target - today) / 86400000)
}

function extractAnalysisDate(text = '', now = new Date()) {
  const contextPattern =
    /\b(?:scadenz[ae]\s+)?(?:entro|fino\s+al?|sino\s+al?)\s+(?:il\s+)?([^,;]+?)(?=\s+(?:e|ed|con|usando|mostrando|nascondendo|includendo|escludendo)\b|$)/i
  const contextMatch = text.match(contextPattern)
  const value = compactText(contextMatch?.[1] || '')
  if (!value || /\b\d{1,3}\s+giorni\b/i.test(value)) return null

  const iso = value.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/)
  if (iso) return isoDateFromParts(iso[3], iso[2], iso[1], now)

  const numeric = value.match(/\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?\b/)
  if (numeric) return isoDateFromParts(numeric[1], numeric[2], numeric[3], now)

  const textual = value.match(
    /\b(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+(\d{2,4}))?\b/i
  )
  if (textual) {
    return isoDateFromParts(textual[1], MONTHS.get(textual[2].toLowerCase()), textual[3], now)
  }

  return null
}

function extractSubject(text = '') {
  const quotedPatterns = [
    /\b(?:usando|usa|imposta|metti|con)?\s*(?:come\s+)?oggetto(?:\s+email)?\s*(?:a|:|=)?\s*["“”']([^"“”']{1,140})["“”']/i,
    /\bsubject\s*(?:a|:|=)?\s*["“”']([^"“”']{1,140})["“”']/i,
  ]

  for (const pattern of quotedPatterns) {
    const match = text.match(pattern)
    if (match?.[1]) return compactText(match[1])
  }

  const unquoted = text.match(
    /\b(?:oggetto(?:\s+email)?|subject)\s*(?:a\s*:|a|:|=)\s*([^,;]+?)(?=\s+(?:e|ed|con|considerando|mostrando|nascondendo|includendo|escludendo)\b|$)/i
  )

  return compactText(unquoted?.[1] || '').replace(/^[:=\-]+\s*/, '') || null
}

function extractEmailNear(text = '', anchorPattern) {
  const match = text.match(anchorPattern)
  const email = compactText(match?.[1] || '').replace(/[.,;:]+$/g, '')
  return EMAIL_PATTERN.test(email) ? email.toLowerCase() : null
}

export function parseEmailGenerationConfiguration(message = '', {now = new Date()} = {}) {
  const text = compactText(message)
  const normalized = normalizeSearchText(text)
  const configuration = {}

  setBooleanFromPatterns(
    configuration,
    'showAllServices',
    normalized,
    [
      /\b(?:mostra|includi|considera)\b.{0,40}\btutti\s+i\s+servizi\b/i,
      /\btutti\s+i\s+servizi\b.{0,40}\b(?:anche\s+)?non\s+critici\b/i,
    ],
    [
      /\b(?:non\s+mostrare|escludi|nascondi)\b.{0,40}\bservizi\s+non\s+critici\b/i,
      /\bsolo\s+(?:i\s+)?servizi\s+critici\b/i,
    ]
  )

  setBooleanFromPatterns(
    configuration,
    'includeDomainRegistrationUsage',
    normalized,
    [
      /\b(?:mostra|mostrando|includi|includendo|visualizza|visualizzando)\b.{0,70}\bdati\s+di\s+occupazione\b.{0,70}\b(?:domreg|domterzolivello|registrazion[ei]\s+dominio)\b/i,
      /\b(?:domreg|domterzolivello)\b.{0,70}\bdati\s+di\s+occupazione\b/i,
    ],
    [
      /\b(?:nascondi|nascondendo|escludi|escludendo|non\s+mostrare)\b.{0,70}\bdati\s+di\s+occupazione\b.{0,70}\b(?:domreg|domterzolivello|registrazion[ei]\s+dominio)\b/i,
    ]
  )

  setBooleanFromPatterns(
    configuration,
    'showPleskAddons',
    normalized,
    [
      /\b(?:mostra|includi|visualizza)\b.{0,40}\badd[- ]?on\b.{0,30}\bplesk\b/i,
      /\badd[- ]?on\b.{0,30}\bplesk\b.{0,30}\b(?:mostra|includi)\b/i,
    ],
    [
      /\b(?:nascondi|escludi|non\s+mostrare)\b.{0,40}\badd[- ]?on\b.{0,30}\bplesk\b/i,
    ]
  )

  setBooleanFromPatterns(
    configuration,
    'showAutoRenewServices',
    normalized,
    [
      /\b(?:mostra|includi|considera)\b.{0,50}\bservizi\b.{0,30}\brinnovo\s+automatico\b/i,
      /\b(?:mostra|includi|considera)\b.{0,50}\brinnovi\s+automatici\b/i,
    ],
    [
      /\b(?:nascondi|escludi|non\s+mostrare|non\s+includere)\b.{0,50}\brinnovi?\s+automatic[oi]\b/i,
    ]
  )

  setBooleanFromPatterns(
    configuration,
    'hideUsageDetails',
    normalized,
    [
      /\b(?:nascondi|ometti)\b.{0,50}\b(?:spazio\s+utilizzato|percentuale\s+di\s+utilizzo|%\s*utilizzo|dettagli\s+di\s+occupazione)\b/i,
    ],
    [
      /\b(?:mostra|visualizza|includi)\b.{0,50}\b(?:spazio\s+utilizzato|percentuale\s+di\s+utilizzo|%\s*utilizzo|dettagli\s+di\s+occupazione)\b/i,
    ]
  )

  setBooleanFromPatterns(
    configuration,
    'hideDiscountDetails',
    normalized,
    [
      /\b(?:nascondi|ometti)\b.{0,50}\b(?:sconto\s+applicato|dettagli\s+(?:dello\s+)?sconto|percentuale\s+di\s+sconto)\b/i,
    ],
    [
      /\b(?:mostra|visualizza|includi)\b.{0,50}\b(?:sconto\s+applicato|dettagli\s+(?:dello\s+)?sconto|percentuale\s+di\s+sconto)\b/i,
    ]
  )

  setBooleanFromPatterns(
    configuration,
    'limitFullSpaceToPeriod',
    normalized,
    [
      /\b(?:limita|considera\s+solo)\b.{0,60}\bservizi\b.{0,30}\bspazio\s+esaurito\b.{0,40}\b(?:periodo|giorni|scadenza)\b/i,
    ],
    [
      /\b(?:non\s+limitare|mostra\s+sempre|includi\s+sempre)\b.{0,60}\bspazio\s+esaurito\b/i,
    ]
  )

  setBooleanFromPatterns(
    configuration,
    'includeFutureLowSpace',
    normalized,
    [
      /\b(?:mostra|includi|considera)\b.{0,60}\bservizi\b.{0,30}\bin\s+esaurimento\b.{0,40}\b(?:oltre|fuori)\b.{0,30}\b(?:periodo|giorni)\b/i,
      /\b(?:mostra|includi)\b.{0,50}\bupgrade\s+futur[oi]\b/i,
    ],
    [
      /\b(?:nascondi|escludi|non\s+mostrare)\b.{0,60}\b(?:servizi\s+)?in\s+esaurimento\b.{0,40}\b(?:oltre|fuori)\b/i,
    ]
  )

  setBooleanFromPatterns(
    configuration,
    'showRecentlyContacted',
    normalized,
    [
      /\b(?:mostra|includi)\b.{0,50}\bservizi\b.{0,30}\b(?:gia\s+)?contattati\b.{0,30}\bultimi\s+6\s+mesi\b/i,
      /\bmostra\b.{0,50}\bgia\s+contattati\b/i,
    ],
    [
      /\b(?:nascondi|escludi|non\s+mostrare)\b.{0,50}\b(?:gia\s+)?contattati\b/i,
    ]
  )

  setBooleanFromPatterns(
    configuration,
    'hideRecentlyCommunicatedUpgrades',
    normalized,
    [
      /\b(?:nascondi|escludi)\b.{0,50}\b(?:servizi\s+di\s+)?upgrade\b.{0,40}\b(?:gia\s+)?comunicati\b/i,
    ],
    [
      /\b(?:mostra|includi|non\s+nascondere)\b.{0,50}\b(?:servizi\s+di\s+)?upgrade\b.{0,40}\b(?:gia\s+)?comunicati\b/i,
    ]
  )

  setBooleanFromPatterns(
    configuration,
    'testMode',
    normalized,
    [
      /\b(?:attiva|usa|imposta|in)\b.{0,20}\bmodalita\s+test\b/i,
      /^(?:la\s+)?modalita\s+test$/i,
    ],
    [
      /\b(?:disattiva|togli|rimuovi|senza)\b.{0,20}\bmodalita\s+test\b/i,
      /\bmodalita\s+test\s+(?:off|disattivata)\b/i,
    ]
  )

  const subject = extractSubject(text)
  if (subject) configuration.subject = subject

  const dayMatch = text.match(/\b(?:scadenz[ae]\s+)?entro\s+(\d{1,3})\s+giorni\b/i)
  if (dayMatch?.[1]) configuration.analysisPeriodDays = Number(dayMatch[1])

  const analysisEndDate = extractAnalysisDate(text, now)
  if (analysisEndDate) {
    configuration.analysisEndDate = analysisEndDate
    configuration.analysisPeriodDays = analysisDaysFromDate(analysisEndDate, now)
  }

  const testEmail =
    extractEmailNear(
      text,
      /\b(?:indirizzo|e-?mail|mail)\s+(?:di\s+)?test\s*(?:(?:a)\s+|[:=]\s*)?([^\s,;]+)/i
    ) ||
    extractEmailNear(
      text,
      /\bmodalita\s+test\b.{0,50}\b(?:a|su|con)\s+([^\s,;]+@[^\s,;]+)/i
    )

  if (testEmail) configuration.testEmail = testEmail

  const recipientEmail = extractEmailNear(
    text,
    /\b(?:destinatari[oa]|invia(?:re)?\s+(?:la\s+)?(?:mail|email)\s+a|mail\s+verra\s+inviata\s+a)\s*(?:(?:a)\s+|[:=]\s*)?([^\s,;]+)/i
  )
  if (recipientEmail && recipientEmail !== testEmail) configuration.recipientEmail = recipientEmail

  return normalizeEmailGenerationConfiguration(configuration, {now})
}

export function normalizeEmailGenerationConfiguration(raw = {}, {now = new Date()} = {}) {
  const configuration = {}
  const errors = []
  const warnings = []
  const source = raw && typeof raw === 'object' ? raw : {}

  for (const field of BOOLEAN_FIELDS) {
    if (typeof source[field] === 'boolean') configuration[field] = source[field]
  }

  if (source.subject !== undefined && source.subject !== null) {
    const subject = compactText(source.subject).slice(0, 140)
    if (subject) configuration.subject = subject
    else errors.push('L’oggetto email non può essere vuoto.')
  }

  for (const field of ['testEmail', 'recipientEmail']) {
    if (source[field] === undefined || source[field] === null) continue
    const email = compactText(source[field]).toLowerCase()
    if (!EMAIL_PATTERN.test(email)) {
      errors.push(`L’indirizzo ${field === 'testEmail' ? 'email di test' : 'destinatario'} non è valido.`)
    } else {
      configuration[field] = email
    }
  }

  if (source.analysisPeriodDays !== undefined && source.analysisPeriodDays !== null) {
    const days = Number(source.analysisPeriodDays)
    if (!Number.isInteger(days) || days < 1 || days > MAX_ANALYSIS_PERIOD_DAYS) {
      errors.push(`Il periodo di analisi deve essere compreso tra 1 e ${MAX_ANALYSIS_PERIOD_DAYS} giorni.`)
    } else {
      configuration.analysisPeriodDays = days
    }
  }

  if (source.analysisEndDate) {
    const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(String(source.analysisEndDate))
      ? String(source.analysisEndDate)
      : null
    const days = analysisDaysFromDate(isoDate, now)

    if (!isoDate || !Number.isInteger(days) || days < 1) {
      errors.push('La data limite delle scadenze deve essere successiva a oggi.')
    } else if (days > MAX_ANALYSIS_PERIOD_DAYS) {
      errors.push(`La data limite non può superare ${MAX_ANALYSIS_PERIOD_DAYS} giorni da oggi.`)
    } else {
      configuration.analysisEndDate = isoDate
      configuration.analysisPeriodDays = days
    }
  }

  if (configuration.testEmail && configuration.testMode === undefined) {
    configuration.testMode = true
  }

  if (configuration.showAllServices === true) {
    configuration.limitFullSpaceToPeriod = false
    configuration.includeFutureLowSpace = false
    configuration.hideRecentlyCommunicatedUpgrades = false
  } else if (
    configuration.limitFullSpaceToPeriod === true ||
    configuration.includeFutureLowSpace === true ||
    configuration.hideRecentlyCommunicatedUpgrades === true
  ) {
    configuration.showAllServices = false
  }

  if (configuration.testMode === false && configuration.testEmail) {
    warnings.push('L’indirizzo di test è stato impostato, ma la modalità test resta disattivata.')
  }

  return {configuration, errors, warnings}
}

export function hasEmailGenerationConfiguration(configuration = {}) {
  return Boolean(configuration && typeof configuration === 'object' && Object.keys(configuration).length)
}

export function isEmailGenerationConfigurationRequest(message = '') {
  const text = normalizeSearchText(message)

  return /\b(?:oggetto\s+(?:email|mail)|subject|modalita\s+test|indirizzo\s+(?:email\s+)?di\s+test|destinatari[oa]|considera\s+scadenze\s+entro|scadenze\s+entro\s+\d+\s+giorni|dati\s+di\s+occupazione|spazio\s+utilizzato|dettagli\s+di\s+occupazione|sconto\s+applicato|dettagli\s+(?:dello\s+)?sconto|add[- ]?on(?:s)?\s+(?:di\s+)?plesk|rinnovo\s+automatico|rinnovi\s+automatici|gia\s+contattati|upgrade\s+gia\s+comunicati|tutti\s+i\s+servizi|servizi\s+non\s+critici|solo\s+(?:i\s+)?servizi\s+critici|spazio\s+esaurito|servizi\s+in\s+esaurimento)\b/i.test(
    text
  )
}

export function stripEmailGenerationConfigurationTail(value = '') {
  const text = compactText(value)
  const marker = text.search(
    /\s+(?:,\s*)?(?:considerando|considera|con\s+scadenz[ae]|scadenz[ae]\s+entro|entro\s+\d{1,3}\s+giorni|fino\s+al?|usando|usa\s+come\s+oggetto|con\s+oggetto|oggetto(?:\s+email)?\s*[:=]|mostrando|nascondendo|includendo|escludendo|in\s+modalita\s+test|modalita\s+test|destinatari[oa])\b/i
  )

  return compactText(marker >= 0 ? text.slice(0, marker) : text)
}

export function describeEmailGenerationConfiguration(configuration = {}) {
  const rows = []

  if (configuration.analysisPeriodDays) {
    rows.push(
      configuration.analysisEndDate
        ? `scadenze fino al ${new Intl.DateTimeFormat('it-IT').format(new Date(`${configuration.analysisEndDate}T00:00:00Z`))}`
        : `scadenze entro ${configuration.analysisPeriodDays} giorni`
    )
  }
  if (configuration.subject) rows.push(`oggetto “${configuration.subject}”`)
  if (configuration.includeDomainRegistrationUsage === true) rows.push('dati di occupazione per domreg e DomTerzoLivello visibili')
  if (configuration.includeDomainRegistrationUsage === false) rows.push('dati di occupazione per domreg e DomTerzoLivello nascosti')
  if (configuration.showAllServices === true) rows.push('tutti i servizi, anche non critici')
  if (configuration.showAllServices === false) rows.push('solo servizi filtrati/critici')
  if (configuration.showPleskAddons === true) rows.push('add-on Plesk visibili')
  if (configuration.showPleskAddons === false) rows.push('add-on Plesk nascosti')
  if (configuration.showAutoRenewServices === true) rows.push('servizi con rinnovo automatico inclusi')
  if (configuration.showAutoRenewServices === false) rows.push('servizi con rinnovo automatico esclusi')
  if (configuration.hideUsageDetails === true) rows.push('dettagli di utilizzo nascosti')
  if (configuration.hideUsageDetails === false) rows.push('dettagli di utilizzo visibili')
  if (configuration.hideDiscountDetails === true) rows.push('dettagli dello sconto nascosti')
  if (configuration.hideDiscountDetails === false) rows.push('dettagli dello sconto visibili')
  if (configuration.limitFullSpaceToPeriod === true) rows.push('servizi con spazio esaurito limitati al periodo')
  if (configuration.limitFullSpaceToPeriod === false) rows.push('servizi con spazio esaurito non limitati al periodo')
  if (configuration.includeFutureLowSpace === true) rows.push('servizi in esaurimento oltre il periodo inclusi')
  if (configuration.includeFutureLowSpace === false) rows.push('servizi in esaurimento oltre il periodo esclusi')
  if (configuration.showRecentlyContacted === true) rows.push('servizi già contattati inclusi')
  if (configuration.showRecentlyContacted === false) rows.push('servizi già contattati esclusi')
  if (configuration.hideRecentlyCommunicatedUpgrades === true) rows.push('upgrade già comunicati nascosti')
  if (configuration.hideRecentlyCommunicatedUpgrades === false) rows.push('upgrade già comunicati visibili')
  if (configuration.testMode === true) rows.push('modalità test attiva')
  if (configuration.testMode === false) rows.push('modalità test disattivata')
  if (configuration.testEmail) rows.push(`email di test ${configuration.testEmail}`)
  if (configuration.recipientEmail) rows.push(`destinatario ${configuration.recipientEmail}`)

  return rows
}
