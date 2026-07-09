import {callOllamaChat} from '../../../core/providers/ollamaProvider.js'
import {buildRenewalsChatMessages} from './prompt.js'
import {buildServiceSnapshot} from './snapshots.js'
import {buildChatContextFromSnapshots} from './context.js'
import {extractSearchQuery, pickChatIntent, pickExplicitChatIntent} from './intents.js'
import {matchesText} from '../../../utils/text.js'
import {buildCommunicationsContext, buildCommunicationsIndex} from './communications.js'
import {planChatRequest} from '../../../core/planner/chatPlanner.js'
import {buildTodoPayloadFromServices} from './todos.js'
import {buildServiceDetailPayload} from './serviceDetails.js'
import {buildServiceListPayload} from './serviceQueries.js'
import {buildDetailedFastToolReply, buildFastToolReply} from './utils/replyFormatters.js'

export async function handleRenewalsChat({
  message,
  customerId = null,
  groupId = null,
  serviceId = null,
  context = {},
  history = [],
  services = [],
  settings = {},
  panelCounts = null,
  debug = {},
}) {
  const analysisPeriod = Number(settings.analysis_period ?? 30)
  const thresholds = settings.renewals_low_thresholds || []

  const plan = planChatRequest({
    message,
    context: {
      ...context,
      customerId,
      groupId,
      serviceId,
    },
  })

  const serviceListPaginationRequest = parseServiceListPaginationRequest(message)
  const previousServiceListState = serviceListPaginationRequest
    ? pickPreviousServiceListState(history, {customerId, groupId, serviceId})
    : null
  const serviceListPagination = previousServiceListState
    ? buildServiceListPagination(previousServiceListState, serviceListPaginationRequest)
    : null

  const explicitIntent = serviceListPaginationRequest
    ? 'service-list'
    : pickExplicitChatIntent(message, {customerId, groupId})

  const parsedIntent = explicitIntent || pickChatIntent(message, {customerId, groupId})
  const isDetailRequest = isDetailsFollowUp(message)
  const isStandaloneDetailRequest = isDetailRequest && !explicitIntent

  const previousIntent = isStandaloneDetailRequest
    ? pickPreviousIntentFromHistory(history, {customerId, groupId})
    : null

  const plannerIntent = plan.type === 'tool' ? plan.intent : null
  const intent = explicitIntent || previousIntent || plannerIntent || parsedIntent

  const baseMeta = {
    moduleId: 'facile.renewals',
    intent,
    explicitIntent,
    parsedIntent,
    plannerIntent,
    previousIntent,
    planType: plan.type,
    isStandaloneDetailRequest,
    servicesCount: debug.servicesCount ?? (Array.isArray(services) ? services.length : null),
    timings: {
      dataLoadMs: debug.dataLoadMs ?? null,
    },
  }

  if (serviceListPaginationRequest && !previousServiceListState) {
    return {
      ok: true,
      intent: 'service-list',
      source: 'tool-fast',
      reply:
        'Non ho una lista precedente da continuare. Chiedimi prima quali servizi vuoi vedere, poi posso mostrarti i risultati successivi.',
      data: {
        type: 'service-list-follow-up-missing',
      },
      meta: {
        ...baseMeta,
        source: 'tool-fast',
      },
    }
  }

  if (serviceListPagination?.blockedReason === 'no-more-results') {
    return {
      ok: true,
      intent: 'service-list',
      source: 'tool-fast',
      reply: 'Non ci sono altri risultati da mostrare per questa lista.',
      data: previousServiceListState?.data || null,
      meta: {
        ...baseMeta,
        source: 'tool-fast',
      },
    }
  }

  if (serviceListPagination?.blockedReason === 'at-start') {
    return {
      ok: true,
      intent: 'service-list',
      source: 'tool-fast',
      reply: 'Sei già all’inizio della lista.',
      data: previousServiceListState?.data || null,
      meta: {
        ...baseMeta,
        source: 'tool-fast',
      },
    }
  }

  if (plan.type === 'direct' && !serviceListPaginationRequest) {
    return {
      ok: true,
      intent: plan.intent,
      source: 'direct',
      reply: plan.reply,
      data: null,
      meta: {
        ...baseMeta,
        source: 'direct',
      },
    }
  }

  let payload = null

  if (intent === 'communications') {
    payload = {
      type: 'communications',
      ...buildCommunicationsContext({
        services,
        customerId,
        groupId,
        message: String(message).trim(),
      }),
    }
  } else if (intent === 'service-detail') {
    payload = buildServiceDetailPayload({
      services,
      settings,
      message: String(message).trim(),
      customerId,
      groupId,
      serviceId,
    })
  } else if (intent === 'service-list') {
    payload = buildServiceListPayload({
      services,
      settings,
      message:
        serviceListPagination?.sourceMessage ||
        resolveServiceListPayloadMessage({
          message,
          history,
          isStandaloneDetailRequest,
          previousIntent,
          customerId,
          groupId,
        }),
      paginationMessage: serviceListPaginationRequest ? String(message).trim() : '',
      previousQuery: previousServiceListState?.query || null,
      pagination: serviceListPagination,
      customerId,
      groupId,
      serviceId,
    })
  } else if (intent === 'search') {
    const q = extractSearchQuery(message)

    if (!q) {
      const error = new Error('Impossibile estrarre una chiave di ricerca valida')
      error.statusCode = 400
      throw error
    }

    const items = services
      .filter(s => {
        return (
          matchesText(s?.name, q) ||
          matchesText(s?.customer?.name, q) ||
          matchesText(s?.customer?.group?.name, q) ||
          matchesText(s?.customer?.businessName, q)
        )
      })
      .map(s => ({
        id: s.id,
        servizio: s?.name || '—',
        cliente: s?.customer?.name || '—',
        gruppo: s?.customer?.group?.name || null,
      }))
      .slice(0, 50)

    payload = {
      type: 'search',
      query: q,
      totale: items.length,
      items,
    }
  } else {
    let filtered = services

    if (serviceId) {
      filtered = filtered.filter(s => String(s?.id) === String(serviceId))
    }

    if (customerId) {
      filtered = filtered.filter(s => String(s?.customer?.id) === String(customerId))
    }

    if (groupId) {
      filtered = filtered.filter(s => String(s?.customer?.group?.id) === String(groupId))
    }

    if (intent === 'todo') {
      payload = buildTodoPayloadFromServices({
        services: filtered,
        settings,
        customerId,
        groupId,
        serviceId,
      })
    } else {
      const snapshots = filtered.map(s => buildServiceSnapshot(s, thresholds, analysisPeriod))

      if (intent === 'space-full') {
        const items = snapshots
          .filter(s => s.isFull)
          .map(s => ({
            tipo: 'upgrade',
            priorita: 'alta',
            servizio: s.name,
            cliente: s.customerName,
            gruppo: s.groupName,
            msg: `Spazio esaurito (${s.percent.toFixed(1)}%)`,
          }))

        payload = {
          type: 'space-full',
          totale: items.length,
          items,
        }
      } else if (intent === 'space-low') {
        const items = snapshots
          .filter(s => s.isLow && !s.isFull)
          .map(s => ({
            tipo: 'upgrade',
            priorita: 'media',
            servizio: s.name,
            cliente: s.customerName,
            gruppo: s.groupName,
            msg: `Spazio in esaurimento (${s.percent.toFixed(1)}%)`,
          }))

        payload = {
          type: 'space-low',
          totale: items.length,
          items,
        }
      } else if (intent === 'dont-renew') {
        const items = snapshots
          .filter(s => s.dontRenew)
          .map(s => ({
            tipo: 'verifica',
            priorita: 'media',
            servizio: s.name,
            cliente: s.customerName,
            gruppo: s.groupName,
            msg: 'Servizio marcato NON RINNOVARE',
          }))

        payload = {
          type: 'dont-renew',
          totale: items.length,
          items,
        }
      } else if (intent === 'to-renew') {
        const items = snapshots
          .filter(s => s.toRenew)
          .map(s => ({
            tipo: 'rinnovo',
            priorita: s.urgentRenewalsCount > 0 ? 'alta' : 'media',
            servizio: s.name,
            cliente: s.customerName,
            gruppo: s.groupName,
            msg: s.nextRenewalDate
              ? `Servizio marcato DA RINNOVARE, prossima scadenza ${s.nextRenewalDate}`
              : 'Servizio marcato DA RINNOVARE',
          }))

        payload = {
          type: 'to-renew',
          totale: items.length,
          items,
        }
      } else if (intent === 'to-transfer') {
        const items = snapshots
          .filter(s => Boolean(s.toTransfer))
          .map(s => ({
            tipo: 'trasferimento',
            priorita: s.urgentRenewalsCount > 0 ? 'alta' : 'media',
            servizio: s.name,
            cliente: s.customerName,
            gruppo: s.groupName,
            msg: s.nextRenewalDate
              ? `Servizio marcato DA TRASFERIRE, prossima scadenza ${s.nextRenewalDate}`
              : 'Servizio marcato DA TRASFERIRE',
          }))

        payload = {
          type: 'to-transfer',
          totale: items.length,
          items,
        }
      } else if (intent === 'anomalies') {
        const items = snapshots
          .filter(s => s.dontRenew && s.autoRenew)
          .map(s => ({
            tipo: 'anomalia',
            priorita: 'alta',
            servizio: s.name,
            cliente: s.customerName,
            gruppo: s.groupName,
            msg: 'Servizio con NON RINNOVARE e RINNOVO AUTOMATICO attivi',
          }))

        payload = {
          type: 'anomalies',
          totale: items.length,
          items,
        }
      } else if (intent === 'critical') {
        const items = snapshots
          .flatMap(s => {
            const out = []

            if (s.isFull) {
              out.push({
                tipo: 'upgrade',
                priorita: 'alta',
                servizio: s.name,
                cliente: s.customerName,
                gruppo: s.groupName,
                msg: 'Spazio esaurito',
              })
            }

            if (s.urgentRenewalsCount > 0) {
              out.push({
                tipo: 'rinnovo',
                priorita: 'alta',
                servizio: s.name,
                cliente: s.customerName,
                gruppo: s.groupName,
                msg: `Rinnovo urgente${s.nextRenewalDate ? ` entro ${s.nextRenewalDate}` : ''}`,
              })
            }

            if (s.dontRenew && s.autoRenew) {
              out.push({
                tipo: 'anomalia',
                priorita: 'alta',
                servizio: s.name,
                cliente: s.customerName,
                gruppo: s.groupName,
                msg: 'Servizio con NON RINNOVARE e RINNOVO AUTOMATICO attivi',
              })
            }

            return out
          })
          .slice(0, 50)

        payload = {
          type: 'critical-services',
          totale: items.length,
          items,
        }
      } else {
        const communications = buildCommunicationsIndex(filtered)

        if (intent === 'customer-report') {
          payload = {
            type: 'customer-report',
            ...buildChatContextFromSnapshots({
              snapshots,
              customerId,
              analysisPeriod,
              communications,
              panelCounts,
            }),
          }
        } else if (intent === 'group-report') {
          payload = {
            type: 'group-report',
            ...buildChatContextFromSnapshots({
              snapshots,
              groupId,
              analysisPeriod,
              communications,
              panelCounts,
            }),
          }
        } else {
          payload = {
            type: 'summary',
            ...buildChatContextFromSnapshots({
              snapshots,
              customerId,
              groupId,
              analysisPeriod,
              communications,
              panelCounts,
            }),
          }
        }
      }
    }
  }

  if (shouldUseFastToolReply(plan, intent)) {
    return {
      ok: true,
      intent,
      source: 'tool-fast',
      reply:
        isStandaloneDetailRequest && previousIntent
          ? buildDetailedFastToolReply(intent, payload)
          : buildFastToolReply(intent, payload, {message}),
      data: payload,
      meta: {
        ...baseMeta,
        source: 'tool-fast',
      },
    }
  }

  try {
    const reply = await callOllamaChat({
      messages: buildRenewalsChatMessages({
        message: String(message).trim(),
        payload,
      }),
    })

    return {
      ok: true,
      intent,
      source: 'llm',
      reply,
      data: payload,
      meta: {
        ...baseMeta,
        source: 'llm',
      },
    }
  } catch (error) {
    return {
      ok: true,
      intent,
      source: 'llm-unavailable',
      reply:
        'Per questa richiesta servirebbe il modello LLM, ma Ollama al momento non è disponibile. Le risposte rapide su rinnovi, criticità, ricerche e attività continuano comunque a funzionare.',
      data: payload,
      warning: {
        type: 'llm_unavailable',
        message: error.message,
      },
      meta: {
        ...baseMeta,
        source: 'llm-unavailable',
      },
    }
  }
}

function shouldUseFastToolReply(plan, intent) {
  if (plan.type === 'tool' && plan.useLlm === false) {
    return true
  }

  return [
    'summary',
    'customer-report',
    'group-report',
    'critical',
    'todo',
    'search',
    'service-list',
    'space-full',
    'space-low',
    'dont-renew',
    'to-renew',
    'to-transfer',
    'anomalies',
    'service-detail',
  ].includes(intent)
}

function resolveServiceListPayloadMessage({
  message = '',
  history = [],
  isStandaloneDetailRequest = false,
  previousIntent = null,
  customerId = null,
  groupId = null,
} = {}) {
  if (!isStandaloneDetailRequest || previousIntent !== 'service-list') {
    return String(message).trim()
  }

  const previousMessage = pickPreviousUserMessageByIntent(history, 'service-list', {
    customerId,
    groupId,
  })

  if (!previousMessage) {
    return String(message).trim()
  }

  return expandServiceListMessageForDetails(previousMessage)
}

function expandServiceListMessageForDetails(message = '') {
  const cleaned = String(message || '')
    .replace(
      /\b(fammi|dammi|mostrami|elencami|voglio|solo|soltanto|al massimo|massimo|primi|prime|i primi|le prime)\s+\d{1,2}\b/gi,
      ' '
    )
    .replace(/\b\d{1,2}\s+(esempi|servizi|risultati|voci)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return `mostrami tutti ${cleaned}`
}

function parseServiceListPaginationRequest(message = '') {
  const text = normalizeFollowUpText(message)
  if (!text) return null

  const direction = isServiceListFirstPageFollowUpText(text)
    ? 'first'
    : isServiceListPreviousFollowUpText(text)
      ? 'previous'
      : isServiceListNextFollowUpText(text)
        ? 'next'
        : null

  if (!direction) return null

  return {
    direction,
    limit: extractServiceListFollowUpLimit(text),
  }
}

function normalizeFollowUpText(message = '') {
  return String(message || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
}

function isServiceListNextFollowUpText(text = '') {
  return (
    /\b(?:mostramene|dammene|elencamene)\s+(?:altr[ei]\s+)?\d{1,2}\b/i.test(text) ||
    /\b(?:altr[ei]|successiv[ei]|prossim[ei]|seguent[ei])(?:\s+\d{1,2})?\b/i.test(text) ||
    /\b(?:continua|prosegui|vai avanti|avanti|ancora)\b/i.test(text) ||
    /\b(?:pagina)\s+(?:dopo|successiva|seguente)\b/i.test(text) ||
    /\b(?:mostra|mostrami|dammi|elenca|elencami)\s+(?:gli\s+|i\s+)?(?:altr[ei]|successiv[ei]|prossim[ei])(?:\s+\d{1,2})?(?:\s+(?:servizi|risultati|voci))?\b/i.test(
      text
    ) ||
    /\bfammi\s+vedere\s+(?:gli\s+|i\s+)?(?:altr[ei]|successiv[ei]|prossim[ei])(?:\s+\d{1,2})?(?:\s+(?:servizi|risultati|voci))?\b/i.test(
      text
    )
  )
}

function isServiceListPreviousFollowUpText(text = '') {
  return (
    /\b(?:precedent[ei]|indietro)\b/i.test(text) ||
    /\btorna\s+indietro\b/i.test(text) ||
    /\bpagina\s+(?:precedente|prima)\b/i.test(text)
  )
}

function isServiceListFirstPageFollowUpText(text = '') {
  return (
    /\b(?:mostrami|mostra|dammi|fammi vedere|elencami|elenca)?\s*(?:i\s+|le\s+)?prim[ei]\s+\d{1,2}\b/i.test(
      text
    ) ||
    /\b(?:torna|riparti|ricomincia)\s+(?:da|dai|dalle)\s+(?:i\s+|le\s+)?prim[ei](?:\s+\d{1,2})?\b/i.test(
      text
    )
  )
}

function extractServiceListFollowUpLimit(text = '') {
  const patterns = [
    /\b(?:mostrami|mostra|dammi|fammi vedere|elencami|elenca)?\s*(?:i\s+|le\s+)?prim[ei]\s+(\d{1,2})\b/i,
    /\b(?:mostramene|dammene|elencamene)\s+(?:altr[ei]\s+)?(\d{1,2})\b/i,
    /\b(?:altr[ei]|successiv[ei]|prossim[ei]|seguent[ei])\s+(\d{1,2})\b/i,
    /\b(?:mostra|mostrami|dammi|elenca|elencami)\s+(?:gli\s+|i\s+)?(?:altr[ei]|successiv[ei]|prossim[ei])\s+(\d{1,2})\b/i,
    /\bfammi\s+vedere\s+(?:gli\s+|i\s+)?(?:altr[ei]|successiv[ei]|prossim[ei])\s+(\d{1,2})\b/i,
    /\b(?:ancora|altri)\s+(\d{1,2})\b/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      return clampServiceListFollowUpLimit(match[1])
    }
  }

  return null
}

function clampServiceListFollowUpLimit(value) {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return null
  return Math.min(Math.max(n, 1), 50)
}

function isServiceListMoreFollowUp(message = '') {
  return parseServiceListPaginationRequest(message)?.direction === 'next'
}

function buildServiceListPagination(previousState, request) {
  const limit = request.limit || previousState.limit || 20
  const shown = previousState.shown || previousState.limit || limit
  const currentOffset = previousState.offset || 0

  if (request.direction === 'first') {
    return {
      direction: 'first',
      limit,
      offset: 0,
      sourceMessage: previousState.sourceMessage,
    }
  }

  if (request.direction === 'previous') {
    if (currentOffset <= 0) {
      return {
        blockedReason: 'at-start',
      }
    }

    return {
      direction: 'previous',
      limit,
      offset: Math.max(currentOffset - limit, 0),
      sourceMessage: previousState.sourceMessage,
    }
  }

  if (previousState.hasMore === false) {
    return {
      blockedReason: 'no-more-results',
    }
  }

  return {
    direction: 'next',
    limit,
    offset: Number.isFinite(previousState.nextOffset)
      ? previousState.nextOffset
      : currentOffset + shown,
    sourceMessage: previousState.sourceMessage,
  }
}

function pickPreviousServiceListState(history = [], scope = {}) {
  const items = Array.isArray(history) ? [...history].reverse() : []

  for (const item of items) {
    if (item?.role !== 'assistant') continue

    const data = getHistoryItemData(item)
    if (data?.type !== 'service-list') continue
    if (!matchesServiceListStateScope(data, scope)) continue

    const query = data.query || {}
    const offset = toFiniteNumber(query.offset, 0)
    const shown = toFiniteNumber(data.shown, Array.isArray(data.items) ? data.items.length : 0)
    const limit = toFiniteNumber(query.limit, shown || 20)
    const hasMore =
      typeof data.hasMore === 'boolean'
        ? data.hasMore
        : typeof data.truncated === 'boolean'
          ? data.truncated
          : null

    return {
      data,
      query,
      sourceMessage:
        query.sourceMessage || pickPreviousUserMessageByIntent(history, 'service-list', scope),
      offset,
      shown,
      limit,
      hasMore,
      nextOffset: Number.isFinite(data.nextOffset) ? data.nextOffset : offset + shown,
      previousOffset: Number.isFinite(data.previousOffset)
        ? data.previousOffset
        : Math.max(offset - limit, 0),
    }
  }

  const sourceMessage = pickPreviousUserMessageByIntent(history, 'service-list', scope)
  const textState = pickPreviousServiceListTextState(history)

  if (!sourceMessage || !textState) {
    return null
  }

  return {
    data: null,
    query: null,
    sourceMessage,
    ...textState,
  }
}

function pickPreviousServiceListTextState(history = []) {
  const items = Array.isArray(history) ? [...history].reverse() : []

  for (const item of items) {
    if (item?.role !== 'assistant') continue

    const content = getHistoryContent(item)
    const state = parseServiceListTextState(content)

    if (state) return state
  }

  return null
}

function parseServiceListTextState(content = '') {
  const text = String(content || '')
  if (!/\b(?:servizi|risultati)\b/i.test(text)) return null

  const range = text.match(/risultati\s+(\d+)\s*-\s*(\d+)/i)

  if (range) {
    const start = Number(range[1])
    const end = Number(range[2])
    const offset = Math.max(start - 1, 0)
    const shown = Math.max(end - start + 1, 0)

    return {
      offset,
      shown,
      limit: shown || 20,
      hasMore: !/non ci sono altri risultati/i.test(text),
      nextOffset: offset + shown,
      previousOffset: Math.max(offset - (shown || 20), 0),
    }
  }

  const firstPage = text.match(/(?:i primi|le prime)\s+(\d+)/i)

  if (firstPage && /ho trovato\s+\d+\s+servizi/i.test(text)) {
    const shown = Number(firstPage[1])

    return {
      offset: 0,
      shown,
      limit: shown || 20,
      hasMore: !/non ci sono altri risultati/i.test(text),
      nextOffset: shown,
      previousOffset: 0,
    }
  }

  const examples = text.match(/ho trovato\s+\d+\s+servizi[\s\S]*?ti mostro\s+(\d+)\s+esempi/i)

  if (examples?.[1]) {
    const shown = Number(examples[1])

    return {
      offset: 0,
      shown,
      limit: shown || 20,
      hasMore: !/non ci sono altri risultati/i.test(text),
      nextOffset: shown,
      previousOffset: 0,
    }
  }

  return null
}

function getHistoryItemData(item = {}) {
  return item?.data || item?.payload || item?.response?.data || item?.result?.data || null
}

function getHistoryContent(item = {}) {
  return String(item?.content || item?.message || item?.text || item?.reply || '').trim()
}

function matchesServiceListStateScope(data = {}, scope = {}) {
  if (!data.scope) return true

  return (
    String(data.scope.customerId || '') === String(scope.customerId || '') &&
    String(data.scope.groupId || '') === String(scope.groupId || '') &&
    String(data.scope.serviceId || '') === String(scope.serviceId || '')
  )
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function pickPreviousUserMessageByIntent(history = [], expectedIntent, scope = {}) {
  const items = Array.isArray(history) ? [...history].reverse() : []

  for (const item of items) {
    if (item?.role !== 'user') continue

    const content = getHistoryContent(item)

    if (!content) continue
    if (parseServiceListPaginationRequest(content)) continue
    if (isDetailsFollowUp(content)) continue

    const intent = pickChatIntent(content, scope)

    if (intent === expectedIntent) {
      return content
    }
  }

  return null
}

function isDetailsFollowUp(message = '') {
  return /(\bpi[uù] dettagli\b|\bdettagli\b|\bapprofondisci\b|\bdimmi di pi[uù]\b|\bspiegami meglio\b|\bentra nel dettaglio\b)/i.test(
    String(message || '')
  )
}

function isGreeting(message = '') {
  return /^(ciao|buongiorno|buonasera|salve|hey|ehi)\b/i.test(String(message || '').trim())
}

function pickAssistantIntentFromText(message = '') {
  const text = String(message || '').toLowerCase()

  if (/attivit[aà] prioritarie/.test(text)) return 'todo'
  if (/criticità principali|criticita principali/.test(text)) return 'critical'
  if (/servizi da rinnovare|marcati .*da rinnovare/.test(text)) return 'to-renew'
  if (/servizi da trasferire|marcati .*da trasferire/.test(text)) return 'to-transfer'
  if (/ho trovato .* risultati/.test(text)) return 'search'
  if (/riepilogo rapido/.test(text)) return 'summary'

  return null
}

function pickPreviousIntentFromHistory(history = [], scope = {}) {
  const items = Array.isArray(history) ? [...history].reverse() : []

  for (const item of items) {
    const content = getHistoryContent(item)

    if (!content) continue

    if (item?.role === 'user') {
      if (isDetailsFollowUp(content) || isGreeting(content)) continue

      const intent = pickChatIntent(content, scope)

      if (intent && intent !== 'summary') {
        return intent
      }
    }

    if (item?.role === 'assistant') {
      const intent = pickAssistantIntentFromText(content)

      if (intent) {
        return intent
      }
    }
  }

  return null
}
