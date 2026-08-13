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
  'webcam-latest-offline',
  'service-detail',
  'customer-report',
  'group-report',
  'summary',
])
const SENSITIVE_KEY = /(?:token|password|secret|api.?key|authorization|authcode|credential)/i

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

  return data
}

export function shouldComposeGroundedReply({message = '', result = {}} = {}) {
  if (!env.groundedRepliesEnabled || result?.ok !== true || !result?.data) return false
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
      timeoutMs: env.groundedReplyTimeoutMs,
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

    if (!reply || reply === 'Nessuna risposta generata.') return result

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
