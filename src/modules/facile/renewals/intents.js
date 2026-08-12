import {matchesText, normalizeText} from '../../../utils/text.js'
import {isMonthExpression} from './utils/dateExpressions.js'

export {matchesText, normalizeText} from '../../../utils/text.js'

function matchAny(text, patterns = []) {
  return patterns.some(pattern => pattern.test(text))
}

const intentRules = [
  {
    intent: 'communications',
    patterns: [
      /(ultima mail|ultima email|ultima comunicazione|ultime comunicazioni)/i,
      /quando.*(mail|email|comunicazione)/i,
      /(mail inviata|email inviata|comunicazione inviata)/i,
    ],
  },
  {
    intent: 'anomalies',
    patterns: [
      /\banomalie\b/i,
      /\banomali\b/i,
      /(non rinnovare).{0,60}(rinnovo automatico|automatico)/i,
      /(rinnovo automatico|automatico).{0,60}(non rinnovare)/i,
    ],
  },
  {
    intent: 'space-full',
    patterns: [
      /(spazio|quota|disco).{0,40}(esaurito|pieno|finito|satur[oa])/i,
      /(servizi|domini).{0,40}(spazio esaurito|disco pieno|quota esaurita)/i,
    ],
  },
  {
    intent: 'space-low',
    patterns: [
      /(spazio|quota|disco).{0,40}(in esaurimento|quasi pieno|quasi esaurito|scarso)/i,
      /(servizi|domini).{0,40}(in esaurimento|quasi pieni|quasi esauriti)/i,
    ],
  },
  {
    intent: 'dont-renew',
    patterns: [
      /(non rinnovare|da non rinnovare|non rinnovo|non vanno rinnovati)/i,
      /(servizi|domini).{0,40}(marcati|segnati).{0,40}(non rinnovare)/i,
    ],
  },
  {
    intent: 'to-renew',
    patterns: [
      /\bda rinnovare\b/i,
      /(servizi|domini).{0,40}(da rinnovare|da rinnovarsi)/i,
      /(marcati|segnati).{0,40}(da rinnovare)/i,
      /\bto[_ -]?renew\b/i,
    ],
  },
  {
    intent: 'to-transfer',
    patterns: [
      /\bda trasferire\b/i,
      /(servizi|domini).{0,40}(da trasferire|da migrare|da spostare)/i,
      /(marcati|segnati).{0,40}(da trasferire|da migrare)/i,
      /\bto[_ -]?transfer\b/i,
    ],
  },
  {
    intent: 'critical',
    patterns: [
      /(criticit|critici|critico|anomali|anomalie|problemi principali)/i,
      /(rinnovi|rinnovo|scadenze|scadenza).{0,40}(urgenti|urgente|critici|critico)/i,
      /(urgenti|urgente|critici|critico).{0,40}(rinnovi|rinnovo|scadenze|scadenza)/i,
    ],
  },
  {
    intent: 'todo',
    scoped: true,
    patterns: [
      /\bcose da fare\b/i,
      /\btodo\b/i,
      /\bda fare\b/i,
      /\battività\b/i,
      /\bazioni da fare\b/i,
      /\bpriorità\b/i,
      /\bprioritari\b/i,
      /\bda controllare\b/i,
      /\bcontrollare\b/i,
      /\bcontrolli\b/i,
      /\bcosa devo controllare\b/i,
      /\bcosa controllo\b/i,
    ],
  },
  {
    intent: 'service-list',
    patterns: [
      /\b(servizi|domini)\b.{0,120}\b(rinnovi imminenti|rinnovo automatico|rinnovi automatici|in scadenza|scadono|scaduti|spazio esaurito|spazio in esaurimento|non rinnovare|da rinnovare|da trasferire|no sync|sincronizzat[oi]|plesk|pian[oi]|plan|abbonament[oi]|fornitor[ei]|provider|supplier|fatturazione|auth code|comunicazioni|traffico|prezzo mancante|record dominio|cliente|gruppo|tipo)\b/i,
      /\b(rinnovi imminenti|rinnovi automatici|servizi scaduti|servizi in scadenza|servizi con spazio|servizi senza spazio)\b/i,
      /\bservizi?\s+di\s+(?!tipo\b|piano\b|spazio\b|fornitore\b)[a-z0-9._@/+ -]{2,}/i,
      /\b(?:servizi|domini)\s+(?!di\b|con\b|senza\b|collegat[oi]\b|non\b|marcat[oi]\b|tipo\b|pian[oi]\b|plan\b|spazio\b|fornitor[ei]\b|provider\b|supplier\b|rinnovi?\b|scadenze?\b|scadut[oi]\b|in\b|da\b|auth\b|record\b|fatturazione\b|traffico\b)[a-z0-9._@/+ -]{2,}/i,
      /\b(?:elenco|lista)\s+(?:servizi|domini)?\s*(?:di\s+)?(?!con\b|senza\b|tipo\b|pian[oi]\b|plan\b|spazio\b|fornitor[ei]\b|provider\b|supplier\b)[a-z0-9._@/+ -]{2,}/i,
      /\bservizi?\s+(?:con|senza|collegat[oi]|non collegat[oi]|marcat[oi])\b/i,
      /\b(?:fammi|mostrami|elencami|dammi)\s+\d{1,2}\s+(?:esempi\s+di\s+)?servizi\b/i,
      /\bservizi?\s+(?:hosting|pec|email|mail|backup|licenze?|server|vps|cloud|domini?)\b/i,
    ],
  },
  {
    intent: 'service-detail',
    patterns: [
      /(dettagli|dettaglio|scheda|analizza|analisi|controlla|verifica|informazioni|info).{0,30}(su|di|del|della|per)\s+["“”']?[a-z0-9._@ -]{2,}/i,
      /^(analizza|controlla|verifica)\s+["“”']?[a-z0-9._@ -]{2,}/i,
      /^scheda\s+(servizio|dominio|cliente)?\s*["“”']?[a-z0-9._@ -]{2,}/i,
    ],
  },

  {
    intent: 'search',
    patterns: [
      /\b(cerca|trova|cerco|cercami|trovami|filtra|filtrami)\b/i,
      /^(servizio|cliente|gruppo)\s+["“”']?[a-z0-9._ -]{2,}/i,
    ],
  },
  {
    intent: 'summary',
    scoped: true,
    patterns: [
      /\briepilogo\b/i,
      /\briassunto\b/i,
      /\bsituazione\b/i,
      /\bpanoramica\b/i,
      /\bcome siamo messi\b/i,
      /\brinnovi\b/i,
      /\bscadenze\b/i,
      /\bin scadenza\b/i,
    ],
  },
]

function resolveScopedIntent(intent, {customerId, groupId} = {}) {
  if (intent !== 'summary' && intent !== 'todo') {
    return intent
  }

  if (customerId) return 'customer-report'
  if (groupId) return 'group-report'

  return intent
}

export function pickCommunicationIntent(message = '') {
  const text = normalizeText(message)
  const rule = intentRules.find(item => item.intent === 'communications')

  return matchAny(text, rule?.patterns || []) ? 'communications' : null
}

function isDontRenewInclusionQuery(text = '') {
  return (
    /\b(includi|includendo|anche|compresi|comprese|inclusi|incluse)\b.{0,50}\b(non rinnovare|da non rinnovare)\b/i.test(
      text
    ) ||
    /\b(non rinnovare|da non rinnovare)\b.{0,50}\b(inclusi|incluse|compresi|comprese|anche)\b/i.test(
      text
    )
  )
}

function isOperationalServiceListQuery(text = '') {
  return /\b(rinnovi?\s+imminenti|in scadenza|scadenze|scadono|scaduti|scadute|spazio esaurito|spazio in esaurimento|fatturazione|da fatturare)\b/i.test(
    text
  )
}

export function pickExplicitChatIntent(message = '', scope = {}) {
  const text = normalizeText(message)

  if (isDontRenewInclusionQuery(text) && isOperationalServiceListQuery(text)) {
    return 'service-list'
  }

  // Una richiesta che nomina esplicitamente una lista di servizi deve essere
  // pianificata come lista anche quando contiene flag (per esempio
  // "non rinnovare" e "da trasferire"). Le regole dei singoli flag sono
  // intenzionalmente più in alto nell'elenco per le richieste sintetiche, ma
  // non devono troncare i filtri composti di una frase interrogativa.
  const serviceListRule = intentRules.find(rule => rule.intent === 'service-list')

  if (matchAny(text, serviceListRule?.patterns || [])) {
    return 'service-list'
  }

  for (const rule of intentRules) {
    if (matchAny(text, rule.patterns)) {
      return rule.scoped ? resolveScopedIntent(rule.intent, scope) : rule.intent
    }
  }

  return null
}

export function pickChatIntent(message = '', {customerId, groupId} = {}) {
  const explicitIntent = pickExplicitChatIntent(message, {customerId, groupId})

  if (explicitIntent) {
    return explicitIntent
  }

  if (customerId) return 'customer-report'
  if (groupId) return 'group-report'

  return 'summary'
}

export function extractSearchQuery(message = '') {
  const text = String(message || '').trim()

  const quoted = text.match(/["“”']([^"“”']{2,})["“”']/)
  if (quoted?.[1]) return quoted[1].trim()

  const cleaned = text
    .replace(
      /\b(cerca|trova|cerco|cercami|trovami|filtra|filtrami|servizio|cliente|gruppo|report|fammi|mostrami|dimmi|per|nome)\b/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned.length >= 2 ? cleaned : null
}

function normalizeGuardText(message = '') {
  return normalizeText(message)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function isExplicitSummaryRequest(message = '') {
  const text = normalizeGuardText(message)

  return /\b(riepilogo|riassunto|situazione|panoramica|overview|come siamo messi|stato generale)\b/i.test(
    text
  )
}

export function isPossiblyOperationalRenewalsRequest(message = '') {
  const text = normalizeGuardText(message)

  if (!text || isExplicitSummaryRequest(text)) {
    return false
  }

  return (
    /\b(servizi|servizio|domini|dominio|piani|piano|plan|abbonamenti|abbonamento)\b/i.test(text) ||
    /\b(rinnovi|rinnovo|scadenze|scadenza|scadono|scaduti|in scadenza|imminenti)\b/i.test(text) ||
    /\b(spazio|quota|disco|plesk|fornitore|fornitori|provider|supplier|fatturazione)\b/i.test(
      text
    ) ||
    /\b(non rinnovare|da non rinnovare|da rinnovare|da trasferire|da migrare)\b/i.test(text) ||
    /\b(auth code|codice auth|record dominio|traffico|comunicazioni|mail|email)\b/i.test(text) ||
    /\b(altri|altre|prossimi|successivi|precedenti|continua|prosegui|avanti|indietro|ancora)\b/i.test(
      text
    ) ||
    /\b(dettagli|dettaglio|approfondisci|dimmi di piu|entra nel dettaglio)\b/i.test(text) ||
    /\b(no|non|sbagliato|correggi|intendevo|volevo dire|invece)\b/i.test(text)
  )
}

const BARE_ENTITY_STOP_WORDS = new Set([
  'ciao',
  'buongiorno',
  'buonasera',
  'salve',
  'grazie',
  'ok',
  'bene',
  'come',
  'cosa',
  'quali',
  'quanto',
  'quando',
  'perché',
  'perche',
  'riepilogo',
  'riassunto',
  'situazione',
  'panoramica',
])

export function isLikelyBareRenewalsEntity(message = '') {
  const original = String(message || '').trim()
  const text = normalizeGuardText(original)

  if (isMonthExpression(text)) {
    return false
  }

  if (!text || isExplicitSummaryRequest(text)) {
    return false
  }

  if (/[?]/.test(original)) {
    return false
  }

  if (
    /\b(servizi|servizio|domini|dominio|rinnovi|rinnovo|scadenze|scadenza|scade|scadono|scadra|scadranno|scaduti|scadute|imminente|imminenti|spazio|plesk)\b/i.test(
      text
    )
  ) {
    return false
  }

  if (/\b(no|non|senza|con|da|in|quelli|questi|altro|altri|prossimi|precedenti)\b/i.test(text)) {
    return false
  }

  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) {
    return true
  }

  if (/\b[a-z0-9.-]+\.[a-z]{2,}\b/i.test(text)) {
    return true
  }

  const words = text
    .split(/\s+/)
    .map(word => word.trim())
    .filter(Boolean)

  if (words.length < 2 || words.length > 6) {
    return false
  }

  if (words.some(word => BARE_ENTITY_STOP_WORDS.has(word))) {
    return false
  }

  return words.every(word => /^[a-z0-9._@/+ -]{2,}$/.test(word))
}

export function buildBareRenewalsEntityServiceListMessage(message = '') {
  const text = String(message || '').trim()

  return isLikelyBareRenewalsEntity(text) ? `servizi di ${text}` : null
}
