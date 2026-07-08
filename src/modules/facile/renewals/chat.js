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

  const explicitIntent = pickExplicitChatIntent(message, {customerId, groupId})
  const parsedIntent = explicitIntent || pickChatIntent(message, {customerId, groupId})
  const isDetailRequest = isDetailsFollowUp(message)
  const isStandaloneDetailRequest = isDetailRequest && !explicitIntent

  const previousIntent = isStandaloneDetailRequest
    ? pickPreviousIntentFromHistory(history, {customerId, groupId})
    : null

  const plannerIntent = plan.type === 'tool' ? plan.intent : null
  const intent = previousIntent || explicitIntent || plannerIntent || parsedIntent

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

  if (plan.type === 'direct') {
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
    'space-full',
    'space-low',
    'dont-renew',
    'anomalies',
    'service-detail',
  ].includes(intent)
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
  if (/ho trovato .* risultati/.test(text)) return 'search'
  if (/riepilogo rapido/.test(text)) return 'summary'

  return null
}

function pickPreviousIntentFromHistory(history = [], scope = {}) {
  const items = Array.isArray(history) ? [...history].reverse() : []

  for (const item of items) {
    const content = String(item?.content || '').trim()

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
