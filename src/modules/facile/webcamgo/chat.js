import {
  buildWebcamDetailPayload,
  buildLatestOfflinePayload,
  buildWebcamListPayload,
  buildWebcamOutagePayload,
  buildWebcamSummaryPayload,
  detectIntent,
  extractDetailTarget,
  parseListQuery,
  parsePaginationRequest,
  parseReferenceRequest,
  parseWebcamHistoryRequest,
  pickPreviousWebcamList,
  pickPreviousWebcamTarget,
  resolveReference,
} from './queries.js'
import {isOpenEntityRequest} from '../../../core/entities/entityResolver.js'
import {getContextEntityTarget} from '../../../core/context/pageContext.js'

function resolveRequestedTarget(message, contextTarget) {
  if (
    contextTarget &&
    /\b(?:questa\s+(?:webcam|telecamera|qui)|quella\s+(?:webcam|telecamera)|(?:webcam|telecamera)\s+(?:corrente|attuale|aperta)|essa)\b/i.test(String(message || ''))
  ) {
    return contextTarget
  }

  return extractDetailTarget(message) || contextTarget
}

export function handleWebcamgoChat({
  message,
  context = {},
  history = [],
  webcams = [],
  statusLogs = [],
  historyRequest = null,
  now = new Date(),
} = {}) {
  const previousList = pickPreviousWebcamList(history)
  const previousTarget = pickPreviousWebcamTarget(history)
  const contextTarget = getContextEntityTarget(context, 'webcam')
  const resolvedHistoryRequest = historyRequest || parseWebcamHistoryRequest(message, now)
  const intent = detectIntent(message, {
    previousList,
    hasActiveEntity: Boolean(contextTarget),
    historyRequest: resolvedHistoryRequest,
  })
  const meta = {
    moduleId: 'facile.webcamgo',
    intent,
    source: 'tool-fast',
  }

  if (intent === 'greeting') {
    return {
      ok: true,
      intent,
      source: 'direct',
      reply:
        'Posso mostrarti le webcam, cercarle per nome o località, filtrare gli stati e aprire il dettaglio dei risultati.',
      data: null,
      meta: {...meta, source: 'direct'},
    }
  }

  if (intent === 'unsupported-action') {
    return {
      ok: true,
      intent,
      source: 'tool-fast',
      reply:
        'In questa prima versione WebcamGo posso eseguire soltanto letture. Riavvii e modifiche tecniche richiederanno un flusso separato con anteprima e conferma.',
      data: {
        type: 'clarification',
        reason: 'read-only-slice',
      },
      meta,
    }
  }

  if (intent === 'webcam-summary') {
    const payload = buildWebcamSummaryPayload(webcams)

    return {
      ok: true,
      intent,
      source: 'tool-fast',
      reply: formatSummaryReply(payload),
      data: payload,
      meta,
    }
  }

  if (intent === 'webcam-outage-history') {
    const payload = buildWebcamOutagePayload({
      webcams,
      logs: statusLogs,
      request: resolvedHistoryRequest,
      now,
    })

    return {
      ok: true,
      intent,
      source: 'tool-fast',
      reply: formatOutageHistoryReply(payload),
      data: payload,
      meta,
    }
  }

  if (intent === 'webcam-latest-offline') {
    const target = resolvedHistoryRequest?.target || contextTarget || previousTarget

    if (!target) {
      return clarification(
        'Di quale webcam vuoi conoscere l’ultimo stato offline? Indica il nome o apri prima la sua scheda.',
        'missing-latest-offline-target',
        meta
      )
    }

    const payload = buildLatestOfflinePayload({webcams, logs: statusLogs, target})

    return {
      ok: true,
      intent,
      source: 'tool-fast',
      reply: formatLatestOfflineReply(payload),
      data: payload,
      meta,
    }
  }

  if (intent === 'webcam-list-pagination') {
    if (!previousList?.query) {
      return clarification(
        'Non ho una lista precedente da continuare. Chiedimi prima quali webcam vuoi vedere.',
        'missing-previous-list',
        meta
      )
    }

    const pagination = parsePaginationRequest(message)

    if (pagination.direction === 'next' && previousList.hasMore === false) {
      return {
        ok: true,
        intent: 'webcam-list',
        source: 'tool-fast',
        reply: 'Non ci sono altre webcam da mostrare per questa lista.',
        data: previousList,
        meta: {...meta, intent: 'webcam-list'},
      }
    }

    if (pagination.direction === 'previous' && Number(previousList.query.offset || 0) <= 0) {
      return {
        ok: true,
        intent: 'webcam-list',
        source: 'tool-fast',
        reply: 'Sei già all’inizio della lista.',
        data: previousList,
        meta: {...meta, intent: 'webcam-list'},
      }
    }

    const query = parseListQuery(message, previousList.query, pagination)
    const payload = buildWebcamListPayload({webcams, query})

    return {
      ok: true,
      intent: 'webcam-list',
      source: 'tool-fast',
      reply: formatListReply(payload),
      data: payload,
      meta: {...meta, intent: 'webcam-list'},
    }
  }

  if (intent === 'webcam-reference') {
    const request = parseReferenceRequest(message, {hasPreviousList: Boolean(previousList)})
    const resolution = resolveReference(request, previousList)

    if (resolution.status !== 'resolved') {
      return clarification(
        formatReferenceClarification(resolution),
        `webcam-reference-${resolution.status}`,
        meta
      )
    }

    const target = resolution.item.slug || resolution.item.name
    const payload = buildWebcamDetailPayload({webcams, target})

    if (isOpenEntityRequest(message)) {
      return buildOpenResponse(payload, meta)
    }

    return {
      ok: true,
      intent: 'webcam-detail',
      source: 'tool-fast',
      reply: formatDetailReply(payload),
      data: payload,
      meta: {...meta, intent: 'webcam-detail'},
    }
  }

  if (intent === 'webcam-open') {
    const target = resolveRequestedTarget(message, contextTarget)

    if (!target) {
      return clarification(
        'Quale webcam vuoi aprire? Indica il nome, la località o lo slug.',
        'missing-open-target',
        meta
      )
    }

    return buildOpenResponse(buildWebcamDetailPayload({webcams, target}), meta)
  }

  if (intent === 'webcam-detail') {
    const target = resolveRequestedTarget(message, contextTarget)

    if (!target) {
      return clarification(
        previousList
          ? 'Quale webcam vuoi approfondire? Indica il nome, lo slug o la posizione nella lista precedente.'
          : 'Quale webcam vuoi approfondire? Indica il nome o lo slug.',
        'missing-detail-target',
        meta
      )
    }

    const payload = buildWebcamDetailPayload({webcams, target})

    return {
      ok: true,
      intent,
      source: 'tool-fast',
      reply: formatDetailReply(payload),
      data: payload,
      meta,
    }
  }

  if (intent === 'webcam-list') {
    const query = parseListQuery(message)
    const payload = buildWebcamListPayload({webcams, query})

    return {
      ok: true,
      intent,
      source: 'tool-fast',
      reply: formatListReply(payload),
      data: payload,
      meta,
    }
  }

  return clarification(
    'Non ho capito la richiesta. Puoi chiedermi un riepilogo, una lista di webcam, uno stato specifico oppure il dettaglio di una webcam.',
    'unrecognized-webcamgo-request',
    meta
  )
}

function buildOpenResponse(payload = {}, meta = {}) {
  if (payload.type === 'webcam-detail-not-found') {
    return {
      ok: true,
      intent: 'webcam-open-not-found',
      source: 'tool-fast',
      reply: formatDetailReply(payload),
      data: payload,
      meta: {...meta, intent: 'webcam-open-not-found'},
    }
  }

  if (payload.type === 'webcam-detail-ambiguous') {
    const items = payload.items || []
    const list = {
      type: 'webcam-list',
      query: {
        term: payload.target,
        label: `webcam corrispondenti a “${payload.target}”`,
        intent: 'open',
        offset: 0,
        limit: items.length,
        shown: items.length,
      },
      totale: items.length,
      shown: items.length,
      hasMore: false,
      nextOffset: items.length,
      previousOffset: null,
      items,
    }

    return {
      ok: true,
      intent: 'webcam-open-ambiguous',
      source: 'tool-fast',
      reply: formatDetailReply(payload),
      data: list,
      meta: {...meta, intent: 'webcam-open-ambiguous'},
    }
  }

  const item = payload.item || {}
  const path = item.slug ? `/webcamgo/webcams/${encodeURIComponent(item.slug)}` : null

  if (!path) {
    return clarification(
      'Ho identificato la webcam, ma non dispone di uno slug utilizzabile per aprirla.',
      'missing-webcam-slug',
      meta
    )
  }

  return {
    ok: true,
    intent: 'app-action',
    source: 'tool-fast',
    reply: `Apro ${item.name || item.slug}.`,
    data: {
      type: 'app-action',
      appAction: {
        id: 'navigate',
        label: `Apri ${item.name || item.slug}`,
        path,
      },
      entity: {
        id: item.id,
        name: item.name,
        slug: item.slug,
        type: 'webcam',
      },
    },
    meta: {...meta, intent: 'app-action'},
  }
}

function clarification(reply, reason, meta) {
  return {
    ok: true,
    intent: 'clarification',
    source: 'tool-fast',
    reply,
    data: {
      type: 'clarification',
      reason,
    },
    meta: {...meta, intent: 'clarification'},
  }
}

function formatSummaryReply(payload = {}) {
  const summary = payload.summary || {}

  return [
    'Riepilogo WebcamGo:',
    `- webcam totali: ${summary.total || 0}`,
    `- in uso: ${summary.inUse || 0}`,
    `- online: ${summary.online || 0}`,
    `- offline o senza stato completo: ${summary.offline || 0}`,
    `- stream non online: ${summary.streamOffline || 0}`,
    `- snapshot non online: ${summary.snapshotOffline || 0}`,
    `- problemi di connettività: ${summary.connectivityProblems || 0}`,
    `- MikroTik non online: ${summary.mikrotikOffline || 0}`,
    `- monitorate: ${summary.monitored || 0}`,
    `- con downtime programmato: ${summary.scheduledDowntime || 0}`,
  ].join('\n')
}

function formatListReply(payload = {}) {
  const total = Number(payload.totale || 0)
  const shown = Number(payload.shown || 0)
  const offset = Number(payload.query?.offset || 0)
  const label = payload.query?.label || 'webcam'

  if (!total) {
    return `Non ho trovato ${label}.`
  }

  const start = offset + 1
  const end = offset + shown
  const intro =
    total === shown && offset === 0
      ? `Ho trovato ${total} ${label}.`
      : `Ho trovato ${total} ${label}. Ti mostro i risultati ${start}-${end}.`

  const lines = payload.items.map((item, index) => {
    const status = item.status?.overall || 'unknown'
    const location = item.location ? ` | ${item.location}` : ''
    const reseller = item.reseller ? ` | reseller ${item.reseller}` : ''
    const flags = [
      item.inUse ? 'in uso' : 'non in uso',
      item.vpn ? 'VPN' : null,
      item.monitored ? 'monitorata' : 'non monitorata',
      item.downtime?.active
        ? 'downtime attivo'
        : item.downtime?.configured
          ? 'downtime configurato'
          : null,
    ]
      .filter(Boolean)
      .join(', ')

    const anomalySince = payload.query?.includeStatusSince
      ? formatCurrentAnomalySince(item)
      : null

    return `${offset + index + 1}. ${item.name} (${item.slug || 'slug assente'})${location}${reseller} | ${status} | ${flags}${anomalySince ? ` | ${anomalySince}` : ''}`
  })

  if (payload.hasMore) {
    lines.push('Puoi chiedermi di mostrare le successive.')
  }

  return [intro, ...lines].join('\n')
}

function formatCurrentAnomalySince(item = {}) {
  const states = [
    ['stream', item.status?.stream],
    ['snapshot', item.snapshotEnabled ? item.status?.snapshot : null],
    ['connettività', item.status?.connectivity],
    ['MikroTik', item.hasMikrotik ? item.status?.mikrotik : null],
  ]
    .filter(([, value]) =>
      value?.status && !['online', 'na', 'n/a', 'unknown'].includes(String(value.status).toLowerCase())
    )
    .map(([label, value]) =>
      `${label} ${value.status}${value.changedOn ? ` dal ${formatDateTime(value.changedOn)}` : ' (inizio non disponibile)'}`
    )

  return states.length ? states.join(', ') : 'inizio anomalia non disponibile'
}

function formatStatus(label, value = {}) {
  const status = value?.status || 'nessun dato'
  const changedOn = value?.changedOn ? ` dal ${formatDateTime(value.changedOn)}` : ''

  return `${label}: ${status}${changedOn}`
}

function formatDetailReply(payload = {}) {
  if (payload.type === 'webcam-detail-not-found') {
    return `Non ho trovato una webcam corrispondente a "${payload.target || ''}".`
  }

  if (payload.type === 'webcam-detail-ambiguous') {
    const options = payload.items.map((item, index) => {
      const location = item.location ? ` — ${item.location}` : ''
      return `${index + 1}. ${item.name} (${item.slug || 'slug assente'})${location}`
    })

    return [
      `Ho trovato più webcam corrispondenti a "${payload.target || ''}". Indica quella corretta:`,
      ...options,
    ].join('\n')
  }

  const item = payload.item || {}
  const monitoring = Object.entries(item.monitoring || {})
    .filter(([key, value]) => key !== 'any' && value)
    .map(([key]) => key)
  const hardware = [item.hardware?.brand, item.hardware?.model].filter(Boolean).join(' ')

  return [
    `${item.name || 'Webcam'} (${item.slug || 'slug assente'})`,
    `Stato complessivo: ${item.status?.overall || 'unknown'}`,
    formatStatus('Stream', item.status?.stream),
    formatStatus('Snapshot', item.status?.snapshot),
    formatStatus('Connettività', item.status?.connectivity),
    item.hasMikrotik ? formatStatus('MikroTik', item.status?.mikrotik) : null,
    `In uso: ${item.inUse ? 'sì' : 'no'}`,
    `Snapshot abilitato: ${item.snapshotEnabled ? 'sì' : 'no'}`,
    `Monitoraggi attivi: ${monitoring.length ? monitoring.join(', ') : 'nessuno'}`,
    item.location ? `Località: ${item.location}` : null,
    item.reseller ? `Reseller: ${item.reseller}` : null,
    item.networkProvider ? `Provider di rete: ${item.networkProvider}` : null,
    hardware ? `Hardware: ${hardware}` : null,
    `VPN: ${item.vpn ? 'sì' : 'no'}`,
    `Encoding configurato: ${item.hasEncoding ? 'sì' : 'no'}`,
    item.downtime?.active
      ? `Downtime attivo: ${formatSchedule(item.downtime.activeSchedule)}`
      : item.downtime?.configured
        ? `Downtime configurati: ${item.downtime.enabledCount || 0} attivi`
        : 'Downtime programmati: nessuno',
  ]
    .filter(Boolean)
    .join('\n')
}

function formatSchedule(schedule = {}) {
  const time = [schedule.timeFrom, schedule.timeTo].filter(Boolean).join('-')
  const name = schedule.name || 'pianificazione'

  return [name, time, schedule.mode].filter(Boolean).join(' | ')
}

function formatDuration(durationMs = 0) {
  const totalMinutes = Math.max(1, Math.round(Number(durationMs || 0) / 60000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60

  return [
    days ? `${days} ${days === 1 ? 'giorno' : 'giorni'}` : null,
    hours ? `${hours} ${hours === 1 ? 'ora' : 'ore'}` : null,
    minutes ? `${minutes} min` : null,
  ].filter(Boolean).join(', ')
}

function formatOutageHistoryReply(payload = {}) {
  if (!payload.items?.length) {
    return `Non risultano webcam con interruzioni superiori a ${formatDuration(payload.minimumDurationMs)} nel periodo richiesto.`
  }

  const rows = payload.items.map((item, index) => {
    const occurrences = item.outages?.length || 0
    return `${index + 1}. ${item.name} (${item.slug || 'slug assente'}) | interruzione massima ${formatDuration(item.longestDurationMs)} | ${occurrences} ${occurrences === 1 ? 'evento' : 'eventi'}`
  })

  return [
    `Ho trovato ${payload.totale} webcam con interruzioni superiori a ${formatDuration(payload.minimumDurationMs)} nel periodo richiesto.`,
    ...rows,
  ].join('\n')
}

function formatLatestOfflineReply(payload = {}) {
  if (payload.type === 'webcam-detail-not-found' || payload.type === 'webcam-detail-ambiguous') {
    return formatDetailReply(payload)
  }

  const item = payload.item || {}
  const event = payload.event
  if (!event) return `Non trovo eventi offline registrati per ${item.name || 'questa webcam'}.`

  return `L’ultimo evento offline di ${item.name} riguarda ${event.type || 'lo stato'} ed è iniziato il ${formatDateTime(event.changedOn)}.`
}

function formatDateTime(value) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date)
}

function formatReferenceClarification(resolution = {}) {
  if (resolution.status === 'empty-list') {
    return 'La lista precedente non contiene webcam selezionabili.'
  }

  if (resolution.status === 'out-of-range') {
    if (resolution.firstPosition && resolution.lastPosition) {
      return `La pagina corrente contiene le webcam numerate da ${resolution.firstPosition} a ${resolution.lastPosition}. Indica una posizione compresa in questo intervallo.`
    }

    return `La pagina corrente contiene ${resolution.available || 0} webcam. Indica una posizione valida.`
  }

  if (resolution.status === 'not-found') {
    return `Non trovo nella pagina corrente una webcam corrispondente a "${resolution.term || ''}". Indica il numero della riga o un nome più preciso.`
  }

  if (resolution.status === 'ambiguous') {
    const options = (resolution.candidates || []).map(candidate => {
      return `${candidate.index + 1}. ${candidate.item.name} (${candidate.item.slug || 'slug assente'})`
    })

    return [
      `Ho trovato più webcam corrispondenti a "${resolution.term || ''}". Indica il numero della riga:`,
      ...options,
    ].join('\n')
  }

  return 'Non sono riuscito a identificare la webcam nella lista precedente.'
}
