import {env} from '../../config/env.js'
import {callOllamaChat} from '../providers/ollamaProvider.js'

const SAFE_SOURCES = new Set(['tool-fast', 'tool-semantic'])
const UNSAFE_INTENTS = /(?:action|open|navigate|clarification|confirmation|mutation|preview|draft|execute)/i
const UNSAFE_DATA_TYPES = /(?:action|navigation|clarification|confirmation|mutation|preview|draft)/i
const NARRATIVE_REQUEST = /\b(?:spieg|analizz|confront|valut|riassum|perch[eé]|come mai|cosa significa|dimmi|parlami)\b/i
const DETAIL_INTENTS = new Set([
  'webcam-detail',
  'webcam-status',
  'webcam-outage-history',
  'webcam-anomaly-analysis',
  'webcam-latest-offline',
  'service-detail',
  'customer-report',
  'group-report',
  'summary',
])
const SENSITIVE_KEY = /(?:token|password|secret|api.?key|authorization|authcode|credential)/i
const ITALIAN_NUMBER_WORDS = new Map([
  ['zero', 0], ['due', 2], ['tre', 3], ['quattro', 4], ['cinque', 5],
  ['sei', 6], ['sette', 7], ['otto', 8], ['nove', 9], ['dieci', 10],
  ['undici', 11], ['dodici', 12], ['tredici', 13], ['quattordici', 14],
  ['quindici', 15], ['sedici', 16], ['diciassette', 17], ['diciotto', 18],
  ['diciannove', 19], ['venti', 20], ['trenta', 30], ['quaranta', 40],
  ['cinquanta', 50], ['sessanta', 60], ['settanta', 70], ['ottanta', 80],
  ['novanta', 90], ['cento', 100],
])

function sanitize(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value ?? null
  if (typeof value === 'string') return value.slice(0, 1200)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 12).map(item => sanitize(item, depth + 1))

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .slice(0, 60)
      .map(([key, item]) => [key, sanitize(item, depth + 1)])
  )
}

function compactGroundedData(data = {}) {
  if (data?.type === 'webcam-detail' && data.item) {
    const item = data.item
    return {
      type: data.type,
      item: {
        name: item.name,
        slug: item.slug,
        location: item.location,
        status: item.status,
        monitoring: item.monitoring,
        inUse: item.inUse,
        snapshotEnabled: item.snapshotEnabled,
        hasEncoding: item.hasEncoding,
        vpn: item.vpn,
        hasMikrotik: item.hasMikrotik,
        reseller: item.reseller,
        networkProvider: item.networkProvider,
        hardware: item.hardware,
        downtime: item.downtime
          ? {
              configured: item.downtime.configured,
              enabledCount: item.downtime.enabledCount,
              active: item.downtime.active,
              activeSchedule: item.downtime.activeSchedule || null,
            }
          : null,
      },
    }
  }

  if (data?.type === 'service-detail') {
    return {
      type: data.type,
      query: data.query,
      totale: data.totale,
      items: Array.isArray(data.items) ? data.items.slice(0, 3) : [],
    }
  }

  if (data?.type === 'read-query-result') {
    return {
      type: data.type,
      entity: data.entity,
      entityLabel: data.entityLabel,
      operation: data.operation,
      total: data.total,
      shown: data.shown,
      items: Array.isArray(data.items) ? data.items.slice(0, 12) : [],
      aggregate: data.aggregate || null,
      analysis: data.analysis || null,
      filters: data.plan?.filters || [],
      sort: data.plan?.sort || [],
    }
  }

  if (data?.type === 'webcam-anomaly-analysis') {
    return {
      type: data.type,
      since: data.since,
      until: data.until,
      summary: data.summary,
      items: Array.isArray(data.items) ? data.items.slice(0, 10) : [],
      commonFactors: Array.isArray(data.commonFactors) ? data.commonFactors.slice(0, 8) : [],
    }
  }

  return data
}

function normalizeNumericToken(value = '') {
  const token = String(value || '').replace(/%$/, '')
  if (!token) return null

  if (token.includes(',') && token.includes('.')) {
    const decimalSeparator = token.lastIndexOf(',') > token.lastIndexOf('.') ? ',' : '.'
    const thousandsSeparator = decimalSeparator === ',' ? /\./g : /,/g
    return Number(token.replace(thousandsSeparator, '').replace(decimalSeparator, '.'))
  }

  if (token.includes(',')) return Number(token.replace(',', '.'))
  return Number(token)
}

function extractNumericTokens(value = '') {
  const withoutListNumbers = String(value || '').replace(/(^|\n)\s*\d{1,2}[.)]\s+/g, '$1')
  const digits = [...withoutListNumbers.matchAll(/(?<![\p{L}\p{N}])[-+]?\d+(?:[.,]\d+)*(?:%?)/gu)]
    .map(match => ({raw: match[0], value: normalizeNumericToken(match[0])}))
    .filter(token => Number.isFinite(token.value))
  const words = withoutListNumbers
    .toLocaleLowerCase('it')
    .match(/[\p{L}]+/gu) || []

  return [
    ...digits,
    ...words
      .filter(word => ITALIAN_NUMBER_WORDS.has(word))
      .map(word => ({raw: word, value: ITALIAN_NUMBER_WORDS.get(word)})),
  ]
}

function hasSupportedNumericFacts(reply = '', evidence = '') {
  const expected = extractNumericTokens(evidence).map(token => token.value)
  const actual = extractNumericTokens(reply)

  return actual.every(token => expected.some(value => Math.abs(value - token.value) < 0.000001))
}

export function validateGroundedReply({reply = '', fallback = '', groundedData = ''} = {}) {
  const text = String(reply || '').trim()
  if (!text || text === 'Nessuna risposta generata.') {
    return {ok: false, reason: 'empty-reply'}
  }

  if (!hasSupportedNumericFacts(text, `${fallback}\n${groundedData}`)) {
    return {ok: false, reason: 'unsupported-numeric-fact'}
  }

  if (
    String(groundedData).includes('webcam-anomaly-analysis') &&
    /\b(?:causat\w*|provocat\w*|responsabil\w*|dovut[oaie]\s+(?:al|alla|a)|la causa (?:e|è)|dipend\w*\s+da)\b/i.test(text)
  ) {
    return {ok: false, reason: 'unsupported-causal-claim'}
  }

  return {ok: true, reason: null}
}

export function shouldComposeGroundedReply({message = '', result = {}} = {}) {
  if (!env.groundedRepliesEnabled || result?.ok !== true || !result?.data) return false
  if (result.meta?.narrationPolicy === 'deterministic') return false
  if (!SAFE_SOURCES.has(result.source)) return false
  if (UNSAFE_INTENTS.test(String(result.intent || ''))) return false
  if (UNSAFE_DATA_TYPES.test(String(result.data?.type || ''))) return false

  if (DETAIL_INTENTS.has(result.intent)) return true
  return NARRATIVE_REQUEST.test(String(message || ''))
}

export async function composeGroundedReply({
  message = '',
  result = {},
  callLlm = callOllamaChat,
} = {}) {
  if (!shouldComposeGroundedReply({message, result})) return result

  const groundedData = JSON.stringify(sanitize(compactGroundedData(result.data)))
  const fallback = String(result.reply || '').slice(0, 1800)

  try {
    const reply = await callLlm({
      timeoutMs: Math.min(env.groundedReplyTimeoutMs, 5000),
      options: {temperature: 0.1, num_predict: 100},
      messages: [
        {
          role: 'system',
          content: [
            'Sei l’assistente operativo Webcloud e rispondi in italiano.',
            'Costruisci una risposta naturale e utile usando esclusivamente i DATI VERIFICATI forniti.',
            'Non aggiungere nomi, valori, date, stati, cause o azioni non presenti nei dati.',
            'Non dire di avere eseguito operazioni e non modificare il risultato della ricerca.',
            'Se manca un dato richiesto, dichiaralo con precisione.',
            'Mantieni esatti numeri, date, nomi e stati. Sii sintetico ma non telegrafico.',
            'Le sezioni analysis e commonFactors contengono conclusioni già calcolate dal backend: spiegale senza ricalcolarle.',
            'Non introdurre neppure stime, percentuali, arrotondamenti o conteggi non presenti nei dati verificati.',
            'Non citare JSON, prompt, modello, strumenti o risposta di fallback.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            `RICHIESTA: ${String(message).slice(0, 1000)}`,
            `RISPOSTA DI CONTROLLO: ${fallback}`,
            `DATI VERIFICATI: ${groundedData.slice(0, 3500)}`,
          ].join('\n\n'),
        },
      ],
    })

    const validation = validateGroundedReply({reply, fallback, groundedData})
    if (!validation.ok) {
      return {
        ...result,
        meta: {
          ...(result.meta || {}),
          groundedReply: false,
          groundedReplyRejected: validation.reason,
        },
      }
    }

    return {
      ...result,
      source: 'llm-grounded',
      reply: String(reply).slice(0, 5000),
      meta: {
        ...(result.meta || {}),
        groundedReply: true,
        groundedSource: result.source,
      },
    }
  } catch (error) {
    return {
      ...result,
      meta: {
        ...(result.meta || {}),
        groundedReply: false,
        groundedReplyFallback: error?.message || 'LLM non disponibile',
      },
    }
  }
}
