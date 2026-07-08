import {callOllamaChat} from '../../../core/providers/ollamaProvider.js'
import {buildRenewalsChatMessages} from './prompt.js'
import {buildServiceSnapshot} from './snapshots.js'
import {buildChatContextFromSnapshots} from './context.js'
import {extractSearchQuery, matchesText, pickChatIntent, pickExplicitChatIntent} from './intents.js'
import {buildCommunicationsContext, buildCommunicationsIndex} from './communications.js'
import {planChatRequest} from '../../../core/planner/chatPlanner.js'
import {buildTodoPayloadFromServices} from './todos.js'
import {buildServiceDetailPayload} from './serviceDetails.js'

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

function buildFastToolReply(intent, payload, options = {}) {
  const message = options.message || ''
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
    const rawItems = filterCriticalItemsForMessage(payload?.items || [], message)
    const items = groupRepeatedItemsForReply(rawItems)

    if (!items.length) {
      return wantsOnlyRenewalCritical(message)
        ? 'Non risultano rinnovi critici nel contesto analizzato.'
        : 'Non risultano criticità rilevanti nel contesto analizzato.'
    }

    return [
      wantsOnlyRenewalCritical(message)
        ? buildCountLabel(rawItems.length, items.length, 'rinnovi critici', {
            groupedWord: 'raggruppati',
          })
        : buildCountLabel(rawItems.length, items.length, 'criticità principali', {
            groupedWord: 'raggruppate',
          }),
      '',
      ...items.slice(0, 10).map(item => formatCriticalItem(item, {message})),
    ].join('\n')
  }

  if (intent === 'todo') {
    const rawItems = payload?.todo || payload?.items || []
    const items = groupRepeatedItemsForReply(rawItems)

    if (!items.length) {
      return 'Non risultano attività prioritarie nel contesto analizzato.'
    }

    return [
      buildCountLabel(rawItems.length, items.length, 'attività prioritarie', {
        groupedWord: 'raggruppate',
      }),
      '',
      ...items.slice(0, 10).map(item => formatTodoItem(item, {message})),
    ].join('\n')
  }

  if (['space-full', 'space-low', 'dont-renew', 'anomalies'].includes(intent)) {
    return buildFastOperationalListReply(intent, payload, {message})
  }

  if (intent === 'service-detail') {
    return buildFastServiceDetailReply(payload)
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

function buildDetailedFastToolReply(intent, payload) {
  if (intent === 'todo') {
    const items = payload?.todo || payload?.items || []

    if (!items.length) {
      return 'Non risultano attività prioritarie da dettagliare nel contesto analizzato.'
    }

    return [
      `Ecco il dettaglio delle ${payload?.totale ?? items.length} attività prioritarie principali.`,
      '',
      ...items.slice(0, 20).map((item, index) => {
        const meta = [
          item.tipo ? `tipo: ${item.tipo}` : null,
          item.cliente ? `cliente: ${item.cliente}` : null,
          item.gruppo ? `gruppo: ${item.gruppo}` : null,
        ]
          .filter(Boolean)
          .join(', ')

        return `${index + 1}. [${item.priorita}] ${item.servizio}: ${item.msg}${
          meta ? ` (${meta})` : ''
        }`
      }),
    ].join('\n')
  }

  if (intent === 'critical') {
    const items = payload?.items || []

    if (!items.length) {
      return 'Non risultano criticità da dettagliare nel contesto analizzato.'
    }

    return [
      `Ecco il dettaglio delle ${payload?.totale ?? items.length} criticità principali.`,
      '',
      ...items.slice(0, 20).map((item, index) => {
        const meta = [
          item.tipo ? `tipo: ${item.tipo}` : null,
          item.cliente ? `cliente: ${item.cliente}` : null,
          item.gruppo ? `gruppo: ${item.gruppo}` : null,
        ]
          .filter(Boolean)
          .join(', ')

        return `${index + 1}. [${item.priorita}] ${item.servizio}: ${item.msg}${
          meta ? ` (${meta})` : ''
        }`
      }),
    ].join('\n')
  }

  if (intent === 'search') {
    const items = payload?.items || []

    if (!items.length) {
      return `Non ho trovato risultati da dettagliare per "${payload?.query || ''}".`
    }

    return [
      `Ecco il dettaglio dei risultati trovati per "${payload?.query || ''}".`,
      '',
      ...items.slice(0, 20).map((item, index) => {
        const meta = [
          item.cliente ? `cliente: ${item.cliente}` : null,
          item.gruppo ? `gruppo: ${item.gruppo}` : null,
        ]
          .filter(Boolean)
          .join(', ')

        return `${index + 1}. ${item.servizio}${meta ? ` (${meta})` : ''}`
      }),
    ].join('\n')
  }

  return buildFastToolReply(intent, payload)
}

function wantsDetails(message = '') {
  return /(\bdettagli\b|\bdettaglio\b|\bcliente\b|\bclienti\b|\bgruppo\b|\bgruppi\b|\bcompleto\b|\bcompleta\b|\bapprofondisci\b)/i.test(
    String(message || '')
  )
}

function wantsOnlyRenewalCritical(message = '') {
  const text = String(message || '').toLowerCase()

  return (
    /(rinnovi|rinnovo|scadenze|scadenza|in scadenza)/i.test(text) &&
    /(criticità|criticita|critici|critico|urgenti|urgente)/i.test(text)
  )
}

function filterCriticalItemsForMessage(items = [], message = '') {
  if (wantsOnlyRenewalCritical(message)) {
    return items.filter(item => item.tipo === 'rinnovo')
  }

  return items
}

function formatMeta(item = {}, {message = ''} = {}) {
  if (!wantsDetails(message)) {
    return ''
  }

  const parts = [
    item.cliente ? `cliente: ${item.cliente}` : null,
    item.gruppo ? `gruppo: ${item.gruppo}` : null,
    item.tipo ? `tipo: ${item.tipo}` : null,
  ].filter(Boolean)

  return parts.length ? ` (${parts.join(', ')})` : ''
}

function formatCriticalItem(item, {message = ''} = {}) {
  const countLabel = item.count > 1 ? ` (${item.count} occorrenze)` : ''

  return `- ${item.servizio}: ${item.msg}${countLabel}${formatMeta(item, {message})}`
}

function formatTodoItem(item, {message = ''} = {}) {
  const countLabel = item.count > 1 ? ` (${item.count} occorrenze)` : ''

  return `- [${item.priorita}] ${item.servizio}: ${item.msg}${countLabel}${formatMeta(item, {
    message,
  })}`
}

function buildCountLabel(rawCount, groupedCount, label, options = {}) {
  const groupedWord = options.groupedWord || 'raggruppati'

  if (rawCount === groupedCount) {
    return `Ho trovato ${rawCount} ${label}.`
  }

  return `Ho trovato ${rawCount} ${label}, ${groupedWord} in ${groupedCount} voci.`
}

function groupRepeatedItemsForReply(items = []) {
  const groups = new Map()

  for (const item of items) {
    const key = [
      item.tipo || '',
      item.priorita || '',
      item.servizio || '',
      item.cliente || '',
      item.gruppo || '',
      item.msg || '',
    ].join('|')

    const existing = groups.get(key)

    if (existing) {
      existing.count += 1
    } else {
      groups.set(key, {
        ...item,
        count: 1,
      })
    }
  }

  return [...groups.values()]
}

function buildFastOperationalListReply(intent, payload, {message = ''} = {}) {
  const rawItems = payload?.items || []
  const items = groupRepeatedItemsForReply(rawItems)

  const labels = {
    'space-full': {
      empty: 'Non risultano servizi con spazio esaurito.',
      found: 'servizi con spazio esaurito',
    },
    'space-low': {
      empty: 'Non risultano servizi con spazio in esaurimento.',
      found: 'servizi con spazio in esaurimento',
    },
    'dont-renew': {
      empty: 'Non risultano servizi marcati NON RINNOVARE.',
      found: 'servizi marcati NON RINNOVARE',
    },
    'anomalies': {
      empty: 'Non risultano anomalie tra NON RINNOVARE e RINNOVO AUTOMATICO.',
      found: 'anomalie',
    },
  }

  const label = labels[intent] || {
    empty: 'Non risultano elementi nel contesto analizzato.',
    found: 'elementi',
  }

  if (!items.length) {
    return label.empty
  }

  return [
    buildCountLabel(rawItems.length, items.length, label.found, {
      groupedWord: 'raggruppati',
    }),
    '',
    ...items.slice(0, 20).map(item => formatOperationalItem(item, {message})),
  ].join('\n')
}

function formatOperationalItem(item, {message = ''} = {}) {
  const countLabel = item.count > 1 ? ` (${item.count} occorrenze)` : ''

  return `- [${item.priorita}] ${item.servizio}: ${item.msg}${countLabel}${formatMeta(item, {
    message: wantsDetails(message) ? message : `${message} dettagli`,
  })}`
}

function buildFastServiceDetailReply(payload) {
  const rawItems = payload?.items || []
  const items = groupServiceDetailItems(rawItems)

  if (!items.length) {
    return `Non ho trovato servizi corrispondenti a "${payload?.query || ''}".`
  }

  const heading =
    payload?.totale > rawItems.length
      ? `Ho trovato ${payload.totale} servizi corrispondenti a "${payload.query}", mostro i primi ${rawItems.length}, raggruppati in ${items.length} schede.`
      : items.length === 1
        ? `Ecco la scheda del servizio "${items[0].servizio}".`
        : `Ho trovato ${payload?.totale ?? rawItems.length} servizi corrispondenti a "${payload?.query || ''}", raggruppati in ${items.length} schede.`

  return [heading, ...items.map(formatServiceDetailItem)].join('\n\n')
}

function formatServiceDetailItem(item) {
  const countLabel = item.count > 1 ? ` (${item.count} occorrenze)` : ''

  const lines = [
    `- Servizio: ${item.servizio}${countLabel}`,
    `  Cliente: ${item.cliente || '—'}${item.gruppo ? ` | Gruppo: ${item.gruppo}` : ''}`,
    ...(item.tipologie?.length ? [`  Tipologie: ${formatServiceTypes(item.tipologie)}`] : []),
    ...(item.dominio?.domainName || item.dominio?.hasPleskDomain
      ? [`  Dominio/Plesk: ${formatDomainInfo(item.dominio, item.flags)}`]
      : []),
    `  Priorità: ${item.priorita}`,
    ...(item.motiviPriorita?.length
      ? [`  Motivo priorità: ${item.motiviPriorita.join('; ')}`]
      : []),
    `  Rinnovi: ${item.rinnovi.urgenti} urgenti, ${item.rinnovi.imminenti} imminenti${
      item.rinnovi.prossimaScadenza
        ? `, prossima scadenza ${formatDate(item.rinnovi.prossimaScadenza)}`
        : ''
    }`,
    `  Spazio: ${formatSpaceStatus(item.spazio)}`,
    `  Flag: ${formatServiceFlags(item.flags)}`,
    ...(item.azioniConsigliate?.length
      ? [`  Azioni consigliate: ${item.azioniConsigliate.join('; ')}`]
      : []),
  ]

  if (item.rinnovi.subscriptions?.length) {
    lines.push(`  Scadenze: ${formatGroupedSubscriptions(item.rinnovi.subscriptions)}`)
  }

  if (item.rinnovi.subscriptions?.length) {
    lines.push(`  Piani: ${formatPlans(item.rinnovi.subscriptions)}`)
  }

  if (item.traffico?.totalTraffic) {
    lines.push(`  Traffico: ${formatTraffic(item.traffico)}`)
  }

  if (item.comunicazioniRecenti?.length) {
    lines.push(
      `  Ultime comunicazioni: ${item.comunicazioniRecenti
        .map(item => {
          const type = item.type ? `tipo ${item.type}` : 'tipo non specificato'
          return `${formatDateTime(item.communicationDate)} (${type})`
        })
        .join(', ')}`
    )
  }

  return lines.join('\n')
}

function formatSpaceStatus(space = {}) {
  if (!space?.quota) {
    return 'quota non disponibile'
  }

  const percent = Number(space.percent || 0).toFixed(1)
  const usage = `${formatBytes(space.used)} / ${formatBytes(space.quota)}`

  if (space.isFull) return `esaurito (${percent}%, ${usage})`
  if (space.isLow) return `in esaurimento (${percent}%, ${usage})`

  return `ok (${percent}%, ${usage})`
}

function formatServiceFlags(flags = {}) {
  const active = []

  if (flags.dontRenew) active.push('NON RINNOVARE')
  if (flags.autoRenew) active.push('rinnovo automatico')
  if (flags.toRenew) active.push('da rinnovare')
  if (flags.toTransfer) active.push('da trasferire')

  return active.length ? active.join(', ') : 'nessun flag rilevante'
}

function groupServiceDetailItems(items = []) {
  const groups = new Map()

  for (const item of items) {
    const key = [
      item.servizio || '',
      item.cliente || '',
      item.gruppo || '',
      item.priorita || '',
      item.rinnovi?.prossimaScadenza || '',
      item.spazio?.isFull ? 'full' : item.spazio?.isLow ? 'low' : 'space-ok',
      item.flags?.dontRenew ? 'dont-renew' : '',
      item.flags?.autoRenew ? 'auto-renew' : '',
      item.flags?.toRenew ? 'to-renew' : '',
      item.flags?.toTransfer ? 'to-transfer' : '',
    ].join('|')

    const existing = groups.get(key)

    if (existing) {
      existing.count += 1
      existing.ids.push(item.id)

      existing.rinnovi = {
        ...existing.rinnovi,
        subscriptions: [
          ...(existing.rinnovi?.subscriptions || []),
          ...(item.rinnovi?.subscriptions || []),
        ],
      }

      existing.comunicazioniRecenti = [
        ...(existing.comunicazioniRecenti || []),
        ...(item.comunicazioniRecenti || []),
      ]
        .sort((a, b) => {
          return new Date(b.communicationDate).getTime() - new Date(a.communicationDate).getTime()
        })
        .slice(0, 5)
    } else {
      groups.set(key, {
        ...item,
        count: 1,
        ids: [item.id],
        rinnovi: {
          ...(item.rinnovi || {}),
          subscriptions: [...(item.rinnovi?.subscriptions || [])],
        },
        spazio: {
          ...(item.spazio || {}),
        },
        flags: {
          ...(item.flags || {}),
        },
        comunicazioniRecenti: [...(item.comunicazioniRecenti || [])],
      })
    }
  }

  return [...groups.values()]
}

function formatGroupedSubscriptions(subscriptions = []) {
  const groups = new Map()

  for (const sub of subscriptions) {
    if (!sub?.endsOn) continue

    const key = [
      sub.endsOn,
      sub.name || '',
      sub.autoRenew === null || sub.autoRenew === undefined ? '' : String(sub.autoRenew),
    ].join('|')

    const existing = groups.get(key)

    if (existing) {
      existing.count += 1
    } else {
      groups.set(key, {
        ...sub,
        count: 1,
      })
    }
  }

  return [...groups.values()]
    .map(sub => {
      const name = sub.name ? ` (${sub.name})` : ''
      const count = sub.count > 1 ? ` (${sub.count} occorrenze)` : ''

      return `${formatDate(sub.endsOn)}${name}${count}`
    })
    .join(', ')
}

function formatDate(value) {
  if (!value) return '—'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return date.toLocaleDateString('it-IT')
}

function formatDateTime(value) {
  if (!value) return '—'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return date.toLocaleString('it-IT', {
    dateStyle: 'short',
    timeStyle: 'short',
  })
}

function formatBytes(value) {
  const bytes = Number(value || 0)

  if (!bytes) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const size = bytes / 1024 ** index

  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatServiceTypes(types = []) {
  return types
    .map(type => {
      if (type.macro && type.name) return `${type.macro} / ${type.name}`
      return type.name || type.macro
    })
    .filter(Boolean)
    .join(', ')
}

function formatDomainInfo(domain = {}, flags = {}) {
  const parts = []

  if (domain.domainName) {
    parts.push(`record dominio ${domain.domainName}`)
  } else {
    parts.push('record dominio assente')
  }

  if (domain.hasPleskDomain) {
    parts.push(`Plesk collegato${domain.hostingType ? `, hosting type ${domain.hostingType}` : ''}`)
  } else {
    parts.push('Plesk non collegato')
  }

  parts.push(flags?.pleskPlansSync ? 'piani Plesk sincronizzati' : 'piani Plesk non sincronizzati')

  return parts.join('; ')
}

function formatPlans(subscriptions = []) {
  return subscriptions
    .map(sub => {
      const parts = []

      parts.push(sub.name || 'piano non indicato')

      if (sub.description) parts.push(sub.description)
      if (sub.supplier) parts.push(`fornitore ${sub.supplier}`)
      if (sub.duration) parts.push(`${sub.duration} mesi`)
      if (sub.priceFinal !== null && sub.priceFinal !== undefined) {
        parts.push(`prezzo ${formatCurrency(sub.priceFinal)}`)
      }
      if (sub.priceListStandard !== null && sub.priceListStandard !== undefined) {
        parts.push(`listino standard ${formatCurrency(sub.priceListStandard)}`)
      }
      if (sub.missingPrice) parts.push('prezzo mancante')

      const supplierPlans = (sub.supplierSubscriptions || [])
        .map(supplierSub => {
          const supplier = supplierSub.supplier ? `${supplierSub.supplier}: ` : ''
          const date = supplierSub.endsOn ? `, scadenza ${formatDate(supplierSub.endsOn)}` : ''
          const missingPrice = supplierSub.missingPrice ? ', prezzo mancante' : ''

          return `${supplier}${supplierSub.name || 'piano fornitore non indicato'}${date}${missingPrice}`
        })
        .filter(Boolean)

      if (supplierPlans.length) {
        parts.push(`piani fornitore: ${supplierPlans.join('; ')}`)
      }

      return parts.join(' | ')
    })
    .join('; ')
}

function formatCurrency(value) {
  const number = Number(value)

  if (!Number.isFinite(number)) return String(value)

  return number.toLocaleString('it-IT', {
    style: 'currency',
    currency: 'EUR',
  })
}

function formatTraffic(traffic = {}) {
  const totalTraffic = formatBytes(traffic.totalTraffic || 0)
  const days = traffic.aggregationCount || null

  return days ? `${totalTraffic} su ${days} rilevazioni` : totalTraffic
}
