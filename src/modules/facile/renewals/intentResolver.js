import {callOllamaChat} from '../../../core/providers/ollamaProvider.js'

const ALLOWED_READ_INTENTS = new Set([
  'service-list',
  'service-detail',
  'communications',
  'search',
  'summary',
  'customer-report',
  'group-report',
  'todo',
  'critical',
  'space-full',
  'space-low',
  'dont-renew',
  'to-renew',
  'to-transfer',
  'anomalies',
  'unknown',
])

const OPERATIONAL_HINT_PATTERN =
  /\b(?:servizi?|domini?|rinnovi?|scadenz[ae]|scade|scadono|scadra|scadranno|scaduti|imminenti|cliente|gruppo|pian[oi]|fornitor[ei]|provider|supplier|plesk|spazio|quota|fatturazione|comunicazioni|mail|email|auth\s*code|da\s+rinnovare|non\s+rinnovare|da\s+trasferire|dettagli|informazioni|info|cerca|trova|elenca|mostra)\b/i

function normalizeConfidence(value) {
  const number = Number(value)

  if (!Number.isFinite(number)) return 0

  return Math.max(0, Math.min(1, number))
}

function normalizeCanonicalMessage(value, fallback = '') {
  if (typeof value !== 'string') return null

  const normalized = value.replace(/\s+/g, ' ').trim()

  if (!normalized || normalized.length > 500) return null
  if (normalized === String(fallback || '').trim()) return normalized

  return normalized
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

function getHistoryText(item = {}) {
  const content = item?.content

  if (typeof content === 'string') return content.trim()
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text.trim()
  }

  return ''
}

function buildRecentConversation(history = []) {
  return (Array.isArray(history) ? history : [])
    .slice(-6)
    .map(item => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: getHistoryText(item),
    }))
    .filter(item => item.content)
}

export function shouldResolveRenewalsIntentSemantically({
  message = '',
  explicitIntent = null,
  serviceListPlan = null,
  serviceListQueryAssessment = null,
  plan = null,
} = {}) {
  const text = String(message || '').trim()

  if (!text || !OPERATIONAL_HINT_PATTERN.test(text)) return false
  if (plan?.type === 'direct') return false

  if (serviceListPlan?.intent === 'clarification') return true

  if (
    explicitIntent === 'service-list' &&
    serviceListQueryAssessment?.valid === false
  ) {
    return true
  }

  if (!explicitIntent) return true

  return explicitIntent === 'summary'
}

export async function resolveRenewalsReadIntent({
  message = '',
  history = [],
  scope = {},
  deterministic = {},
  timeoutMs = 5000,
} = {}) {
  const text = String(message || '').trim()

  if (!text) return null

  const systemPrompt = [
    'Sei il router semantico del modulo rinnovi Webcloud.',
    'Devi comprendere la richiesta, non rispondere all’utente e non eseguire operazioni.',
    'Le action di modifica, le conferme, gli annullamenti e le diagnostiche dedicate sono gestite da altri componenti.',
    'Classifica soltanto richieste di lettura usando uno degli intent consentiti.',
    'Distingui sempre richieste plurali o globali da richieste su un singolo servizio.',
    'Esempi: "tutti i servizi che scadono nel 2027", "servizi in scadenza imminente" e "servizi in scadenza" sono service-list.',
    '"info su example.it" è service-detail.',
    '"riepilogo rinnovi" è summary.',
    'Per service-list genera canonicalMessage mantenendo nomi, date, anni, quantità e filtri, ma riscrivendo la frase in una forma semplice comprensibile dal planner.',
    'Per una richiesta su un intero anno usa la forma "servizi con scadenza nel 2027".',
    'Per una scadenza del fornitore usa la forma "servizi con scadenza fornitore <periodo>" e non aggiungere un filtro cliente.',
    'Non trasformare parole operative come "scadono nel 2027" nel nome di un cliente, gruppo, piano o fornitore.',
    'Per service-detail genera canonicalMessage nella forma "info su <servizio>" quando il target è presente.',
    'Se non sei sicuro usa unknown.',
    'Restituisci esclusivamente JSON valido senza markdown.',
  ].join(' ')

  const userPayload = {
    request: text,
    scope: {
      customerId: scope?.customerId || null,
      groupId: scope?.groupId || null,
      serviceId: scope?.serviceId || null,
    },
    deterministic: {
      explicitIntent: deterministic?.explicitIntent || null,
      plannerIntent: deterministic?.plannerIntent || null,
      serviceListPlanIntent: deterministic?.serviceListPlanIntent || null,
      serviceListQuery: deterministic?.serviceListQuery || null,
      serviceListQueryWarnings: Array.isArray(deterministic?.serviceListQueryWarnings)
        ? deterministic.serviceListQueryWarnings
        : [],
    },
    recentConversation: buildRecentConversation(history),
    allowedIntents: [...ALLOWED_READ_INTENTS],
    outputSchema: {
      intent: 'allowed intent',
      confidence: 'number between 0 and 1',
      canonicalMessage: 'string or null',
      targetMode: 'list | single | global | unknown',
      reason: 'short string',
    },
  }

  try {
    const raw = await callOllamaChat({
      timeoutMs,
      messages: [
        {role: 'system', content: systemPrompt},
        {role: 'user', content: JSON.stringify(userPayload)},
      ],
    })

    const parsed = extractJsonObject(raw)
    const intent = String(parsed?.intent || '').trim()

    if (!ALLOWED_READ_INTENTS.has(intent)) return null

    const confidence = normalizeConfidence(parsed?.confidence)

    if (intent === 'unknown' || confidence < 0.7) {
      return {
        intent: 'unknown',
        confidence,
        canonicalMessage: null,
        targetMode: 'unknown',
        reason: String(parsed?.reason || '').slice(0, 240) || null,
      }
    }

    const canonicalMessage = normalizeCanonicalMessage(parsed?.canonicalMessage, text)
    const targetMode = ['list', 'single', 'global', 'unknown'].includes(parsed?.targetMode)
      ? parsed.targetMode
      : 'unknown'

    return {
      intent,
      confidence,
      canonicalMessage,
      targetMode,
      reason: String(parsed?.reason || '').slice(0, 240) || null,
    }
  } catch {
    return null
  }
}
