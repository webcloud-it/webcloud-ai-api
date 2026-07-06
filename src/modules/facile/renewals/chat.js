import {callOllamaChat} from '../../../core/providers/ollamaProvider.js'
import {buildRenewalsChatMessages} from './prompt.js'
import {buildServiceSnapshot} from './snapshots.js'
import {buildChatContextFromSnapshots} from './context.js'
import {extractSearchQuery, matchesText, pickChatIntent} from './intents.js'
import {buildCommunicationsContext, buildCommunicationsIndex} from './communications.js'
import {planChatRequest} from '../../../core/planner/chatPlanner.js'

export async function handleRenewalsChat({
  message,
  customerId = null,
  groupId = null,
  serviceId = null,
  context = {},
  services = [],
  settings = {},
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
  const intent = plan.intent || pickChatIntent(message, {customerId, groupId})

  if (plan.type === 'direct') {
    return {
      ok: true,
      intent: plan.intent,
      reply: plan.reply,
      data: null,
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

    const snapshots = filtered.map(s => buildServiceSnapshot(s, thresholds, analysisPeriod))
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
    } else if (intent === 'todo') {
      payload = {
        type: 'todo',
        ...buildChatContextFromSnapshots({
          snapshots,
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

  if (plan.type === 'tool' && plan.useLlm === false) {
    return {
      ok: true,
      intent,
      reply: buildFastToolReply(intent, payload),
      data: payload,
    }
  }

  const reply = await callOllamaChat({
    messages: buildRenewalsChatMessages({
      message: String(message).trim(),
      payload,
    }),
  })

  return {
    ok: true,
    intent,
    reply,
    data: payload,
  }
}

function buildFastSummaryReply(payload) {
  const summary = payload?.summary || {}

  return [
    'Ecco il riepilogo rapido dei rinnovi.',
    '',
    `Servizi totali: ${summary.total ?? payload?.total ?? '—'}`,
    `Rinnovi imminenti: ${summary.expiring ?? '—'}`,
    `Rinnovi urgenti: ${summary.urgent ?? '—'}`,
    `Spazio esaurito: ${summary.full ?? '—'}`,
    `Spazio in esaurimento: ${summary.low ?? '—'}`,
    `Non rinnovare: ${summary.dontRenew ?? '—'}`,
  ].join('\n')
}

function buildFastToolReply(intent, payload) {
  if (intent === 'summary') {
    return buildFastSummaryReply(payload)
  }

  if (intent === 'customer-report') {
    return buildFastScopedReportReply('cliente', payload)
  }

  if (intent === 'group-report') {
    return buildFastScopedReportReply('gruppo', payload)
  }

  if (intent === 'critical') {
    const items = payload?.items || []

    if (!items.length) {
      return 'Non risultano criticità rilevanti nel contesto analizzato.'
    }

    return [
      `Ho trovato ${payload?.totale ?? items.length} criticità principali.`,
      '',
      ...items.slice(0, 10).map(item => `- ${item.servizio}: ${item.msg}`),
    ].join('\n')
  }

  if (intent === 'todo') {
    const items = payload?.todo || []

    if (!items.length) {
      return 'Non risultano attività prioritarie nel contesto analizzato.'
    }

    return [
      `Ho trovato ${items.length} attività prioritarie.`,
      '',
      ...items.slice(0, 10).map(item => `- [${item.priorita}] ${item.servizio}: ${item.msg}`),
    ].join('\n')
  }

  if (intent === 'search') {
    const items = payload?.items || []

    if (!items.length) {
      return `Non ho trovato risultati per "${payload?.query || ''}".`
    }

    return [
      `Ho trovato ${payload?.totale ?? items.length} risultati.`,
      '',
      ...items.slice(0, 10).map(item => `- ${item.servizio} — ${item.cliente}`),
    ].join('\n')
  }

  return payload?.text || 'Operazione completata.'
}

function buildFastScopedReportReply(label, payload) {
  const summary = payload?.summary || {}

  return [
    `Ecco il riepilogo rapido per questo ${label}.`,
    '',
    `Servizi totali: ${summary.total ?? '—'}`,
    `Rinnovi imminenti: ${summary.expiring ?? '—'}`,
    `Rinnovi urgenti: ${summary.urgent ?? '—'}`,
    `Spazio esaurito: ${summary.full ?? '—'}`,
    `Spazio in esaurimento: ${summary.low ?? '—'}`,
    `Non rinnovare: ${summary.dontRenew ?? '—'}`,
  ].join('\n')
}
