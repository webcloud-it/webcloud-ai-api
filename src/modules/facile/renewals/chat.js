import {callOllamaChat} from '../../../core/providers/ollamaProvider.js'
import {buildRenewalsChatMessages} from './prompt.js'
import {buildServiceSnapshot} from './snapshots.js'
import {buildChatContextFromSnapshots} from './context.js'
import {
  buildBareRenewalsEntityServiceListMessage,
  extractSearchQuery,
  pickChatIntent,
  pickExplicitChatIntent,
} from './intents.js'
import {matchesText} from '../../../utils/text.js'
import {buildCommunicationsContext, buildCommunicationsIndex} from './communications.js'
import {planChatRequest} from '../../../core/planner/chatPlanner.js'
import {buildTodoPayloadFromServices} from './todos.js'
import {buildServiceDetailPayload} from './serviceDetails.js'
import {buildServiceListPayload} from './serviceQueries.js'
import {planServiceListRequest} from './serviceQueryPlanner.js'
import {
  buildServiceListPagination,
  parseServiceListPaginationRequest,
} from './serviceListPagination.js'
import {
  parseServiceListReferenceRequest,
  resolveServiceListReference,
} from './serviceListReferences.js'
import {
  getHistoryContent,
  isDetailsFollowUp,
  pickPreviousServiceListState,
} from './serviceListState.js'
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
  const previousServiceListState = pickPreviousServiceListState(
    history,
    {
      customerId,
      groupId,
      serviceId,
    },
    settings,
    message
  )
  const serviceListReferenceRequest = parseServiceListReferenceRequest(message, {
    allowBarePosition: Boolean(previousServiceListState),
  })

  const serviceListReference = serviceListReferenceRequest
    ? resolvePreviousServiceListReference({
        request: serviceListReferenceRequest,
        previousState: previousServiceListState,
        services,
        settings,
        customerId,
        groupId,
        serviceId,
      })
    : null
  const serviceListPagination =
    previousServiceListState && serviceListPaginationRequest
      ? buildServiceListPagination(previousServiceListState, serviceListPaginationRequest)
      : null
  const serviceListPlan =
    serviceListPaginationRequest || serviceListReferenceRequest
      ? null
      : planServiceListRequest({
          message,
          previousState: previousServiceListState,
          settings,
        })
  const explicitIntent = serviceListReferenceRequest
    ? serviceListReference?.status === 'resolved'
      ? 'service-detail'
      : 'clarification'
    : serviceListPaginationRequest || serviceListPlan?.intent === 'service-list'
      ? 'service-list'
      : serviceListPlan?.intent === 'clarification'
        ? 'clarification'
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
    serviceListPlan: serviceListPlan
      ? {
          mode: serviceListPlan.mode,
          confidence: serviceListPlan.confidence,
        }
      : null,
    serviceListReference: serviceListReferenceRequest
      ? {
          status: serviceListReference?.status || null,
          selector: serviceListReferenceRequest.selector,
        }
      : null,
    isStandaloneDetailRequest,
    servicesCount: debug.servicesCount ?? (Array.isArray(services) ? services.length : null),
    timings: {
      dataLoadMs: debug.dataLoadMs ?? null,
    },
  }

  if (serviceListPlan?.intent === 'clarification') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: serviceListPlan.clarification.question,
      data: {
        type: 'clarification',
        reason: serviceListPlan.clarification.reason,
      },
      meta: {
        ...baseMeta,
        intent: 'clarification',
        source: 'tool-fast',
        guard: serviceListPlan.clarification.reason,
      },
    }
  }

  if (serviceListReferenceRequest && serviceListReference?.status !== 'resolved') {
    const reason = `service-list-reference-${serviceListReference?.status || 'unresolved'}`

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildServiceListReferenceClarification(serviceListReference),
      data: {
        type: 'clarification',
        reason,
      },
      meta: {
        ...baseMeta,
        intent: 'clarification',
        source: 'tool-fast',
        guard: reason,
      },
    }
  }

  if (
    shouldStopUnsafeSummaryFallback({
      message,
      intent,
      explicitIntent,
      previousIntent,
      plannerIntent,
      plan,
      serviceListPaginationRequest,
    })
  ) {
    const previousList = pickPreviousServiceListState(
      history,
      {customerId, groupId, serviceId},
      settings,
      message
    )

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildUnsafeSummaryFallbackReply({hasPreviousList: Boolean(previousList)}),
      data: {
        type: 'clarification',
        reason: 'unsafe-summary-fallback',
        previousList: previousList
          ? {
              label: previousList.query?.label || null,
              offset: previousList.offset,
              shown: previousList.shown,
              limit: previousList.limit,
              hasMore: previousList.hasMore,
            }
          : null,
      },
      meta: {
        ...baseMeta,
        intent: 'clarification',
        source: 'tool-fast',
        guard: 'unsafe-summary-fallback',
      },
    }
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

  if (
    plan.type === 'direct' &&
    !serviceListPaginationRequest &&
    !serviceListPlan &&
    !serviceListReferenceRequest
  ) {
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
    const referencedItem = serviceListReference?.item || null
    const referencedServiceIds = getReferencedServiceIds(referencedItem)

    payload = buildServiceDetailPayload({
      services,
      settings,
      message: referencedItem?.servizio || referencedItem?.dominio || String(message).trim(),
      customerId: referencedItem?.customerId || customerId,
      groupId: referencedItem?.groupId || groupId,
      serviceId:
        referencedServiceIds.length === 1
          ? referencedServiceIds[0]
          : referencedItem
            ? null
            : serviceId,
      serviceIds: referencedServiceIds.length > 1 ? referencedServiceIds : [],
    })
  } else if (intent === 'service-list') {
    const serviceListPayloadMessage =
      serviceListPlan?.sourceMessage ??
      serviceListPagination?.sourceMessage ??
      resolveServiceListPayloadMessage({
        message,
        history,
        isStandaloneDetailRequest,
        previousIntent,
        customerId,
        groupId,
      })

    payload = buildServiceListPayload({
      services,
      settings,
      message: serviceListPayloadMessage,
      paginationMessage: serviceListPaginationRequest ? String(message).trim() : '',
      previousQuery:
        serviceListPlan?.previousQuery ??
        (serviceListPaginationRequest ? previousServiceListState?.query || null : null),
      pagination: serviceListPlan?.pagination ?? serviceListPagination,
      includeDontRenewOverride: serviceListPlan?.includeDontRenewOverride ?? null,
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

function shouldStopUnsafeSummaryFallback({
  intent = null,
  explicitIntent = null,
  previousIntent = null,
  plannerIntent = null,
  plan = {},
  serviceListPaginationRequest = null,
} = {}) {
  if (intent !== 'summary') return false

  if (explicitIntent || previousIntent || serviceListPaginationRequest) {
    return false
  }

  if (plan?.type === 'direct') {
    return false
  }

  if (plan?.type === 'tool' && plannerIntent === 'summary') {
    return false
  }

  return true
}

function buildUnsafeSummaryFallbackReply({hasPreviousList = false} = {}) {
  if (hasPreviousList) {
    return [
      'Non ho capito cosa vuoi fare adesso.',
      'Vuoi approfondire il riepilogo, tornare alla lista precedente oppure fare una nuova ricerca?',
    ].join(' ')
  }

  return [
    'Non ho capito la richiesta.',
    'Puoi indicare un cliente o gruppo, un piano, uno stato, un problema di spazio, Plesk o una scadenza.',
  ].join(' ')
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

function resolvePreviousServiceListReference({
  request,
  previousState,
  services = [],
  settings = {},
  customerId = null,
  groupId = null,
  serviceId = null,
} = {}) {
  if (!previousState?.query?.filters?.length) {
    return {
      status: 'missing-list',
    }
  }

  const currentItems = Array.isArray(previousState?.data?.items)
    ? previousState.data.items
    : buildServiceListPayload({
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
        customerId,
        groupId,
        serviceId,
      }).items

  return resolveServiceListReference({
    request,
    items: currentItems,
  })
}

function getReferencedServiceIds(item = null) {
  if (!item) {
    return []
  }

  return [...new Set([...(item.ids || []), item.id].filter(Boolean).map(String))]
}

function buildServiceListReferenceClarification(resolution = {}) {
  if (resolution.status === 'missing-list') {
    return [
      'Non ho una lista precedente da cui selezionare il servizio.',
      'Chiedimi prima quali servizi vuoi vedere.',
    ].join(' ')
  }

  if (resolution.status === 'empty-list') {
    return 'La lista precedente non contiene servizi selezionabili.'
  }

  if (resolution.status === 'out-of-range') {
    return [
      `La pagina corrente contiene ${resolution.available || 0} servizi.`,
      `Indica una posizione compresa tra 1 e ${resolution.available || 0}.`,
    ].join(' ')
  }

  if (resolution.status === 'not-found') {
    return [
      `Non trovo nella pagina corrente un servizio corrispondente a "${resolution.term || ''}".`,
      'Puoi indicare il numero della riga o un nome più preciso.',
    ].join(' ')
  }

  if (resolution.status === 'ambiguous') {
    const options = (resolution.candidates || []).slice(0, 5).map(candidate => {
      const item = candidate.item || {}
      const customer = item.cliente ? ` — ${item.cliente}` : ''
      const plan = item.piano ? ` | piano ${item.piano}` : ''

      return `${candidate.index + 1}. ${
        item.servizio || item.dominio || 'Servizio'
      }${customer}${plan}`
    })

    return [
      `Ho trovato più servizi corrispondenti a "${resolution.term || ''}". Indica il numero della riga:`,
      ...options,
    ].join('\n')
  }

  return [
    'Non sono riuscito a identificare il servizio nella lista precedente.',
    'Indica il numero della riga o il nome del servizio.',
  ].join(' ')
}

function pickPreviousUserMessageByIntent(history = [], expectedIntent, scope = {}) {
  const items = Array.isArray(history) ? [...history].reverse() : []

  for (const item of items) {
    if (item?.role !== 'user') continue

    const content = getHistoryContent(item)

    if (!content) continue
    if (parseServiceListPaginationRequest(content)) continue
    if (isDetailsFollowUp(content)) continue
    if (expectedIntent === 'service-list') {
      const bareServiceMessage = buildBareRenewalsEntityServiceListMessage(content)

      if (bareServiceMessage) {
        return bareServiceMessage
      }
    }

    const intent = pickChatIntent(content, scope)

    if (intent === expectedIntent) {
      return content
    }
  }

  return null
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
