import {
  buildCountLabel,
  formatBytes,
  formatCurrency,
  formatDate,
  formatDateTime,
} from '../../../../utils/formatters.js'
import {groupByKey} from '../../../../utils/collections.js'

export function buildFastToolReply(intent, payload, options = {}) {
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

  if (intent === 'service-list') {
    return buildFastServiceListReply(payload)
  }

  if (
    ['space-full', 'space-low', 'dont-renew', 'to-renew', 'to-transfer', 'anomalies'].includes(
      intent
    )
  ) {
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

export function buildDetailedFastToolReply(intent, payload) {
  if (intent === 'service-list') {
    return buildDetailedServiceListReply(payload)
  }

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

function buildFastServiceListReply(payload) {
  const items = payload?.items || []
  const label = payload?.query?.label || 'servizi'

  if (!items.length) {
    if (payload?.query?.requestedMore || payload?.query?.requestedPrevious) {
      return 'Non ci sono risultati da mostrare per questa pagina.'
    }

    const suggestion = payload?.query?.suggestion || null

    if (suggestion?.kind === 'include-dont-renew') {
      const count = Number(suggestion.count || 0)
      const countLabel =
        count === 1 ? '1 servizio marcato NON RINNOVARE' : `${count} servizi marcati NON RINNOVARE`

      return [
        `Non ho trovato ${label} tra i servizi rinnovabili.`,
        `Ho però trovato ${countLabel} che corrispondono alla richiesta.`,
        'Vuoi che li mostri includendo anche questi servizi?',
      ].join(' ')
    }

    return [
      `Non ho trovato ${label}.`,
      'Vuoi modificare o rimuovere uno dei filtri per ampliare la ricerca?',
    ].join(' ')
  }

  return [
    buildServiceListIntro(payload),
    '',
    ...items.map(item => formatServiceListItem(item)),
  ].join('\n')
}

function buildDetailedServiceListReply(payload) {
  const items = payload?.items || []
  const label = payload?.query?.label || 'servizi'

  if (!items.length) {
    return `Non ho trovato ${label} da dettagliare.`
  }

  return [
    buildServiceListIntro(payload, {detailed: true}),
    '',
    ...items.map(item => formatServiceListItem(item, {detailed: true})),
  ].join('\n')
}

function buildServiceListIntro(payload, {detailed = false} = {}) {
  const label = payload?.query?.label || 'servizi'
  const total = payload?.totale ?? 0
  const shown = payload?.shown ?? payload?.items?.length ?? 0
  const offset = Number(payload?.query?.offset || 0)

  const requestedMore = payload?.query?.requestedMore === true
  const requestedPrevious = payload?.query?.requestedPrevious === true
  const requestedFirst = payload?.query?.requestedFirst === true
  const rangeLabel = offset > 0 && shown > 0 ? ` i risultati ${offset + 1}-${offset + shown}` : null
  const requestedLimit = payload?.query?.requestedLimit === true
  const requestedAll = payload?.query?.requestedAll === true
  const truncated = payload?.truncated === true
  const excludedDontRenew = payload?.query?.excludedDontRenew === true
  const grouped = payload?.grouped === true
  const groups = payload?.groups ?? shown
  const groupedNote = grouped ? `, raggruppati in ${groups} righe` : ''
  const dontRenewInfo = payload?.query?.dontRenew || null
  const explicitDontRenewMode = dontRenewInfo?.explicitMode || null
  const dontRenewMatches = Number(dontRenewInfo?.matchedInRequest || 0)

  const noteParts = []
  const dontRenewLabel =
    dontRenewMatches === 1
      ? '1 servizio marcato NON RINNOVARE'
      : `${dontRenewMatches} servizi marcati NON RINNOVARE`

  if (explicitDontRenewMode === 'include') {
    if (dontRenewMatches > 0) {
      noteParts.push(`Sono inclusi ${dontRenewLabel} per questa richiesta.`)
    } else {
      noteParts.push(
        'Per questa richiesta non risultano servizi marcati NON RINNOVARE da includere.'
      )
    }
  } else if (explicitDontRenewMode === 'exclude') {
    if (dontRenewMatches > 0) {
      noteParts.push(`Sono esclusi ${dontRenewLabel} per questa richiesta.`)
    } else {
      noteParts.push(
        'Per questa richiesta non risultano servizi marcati NON RINNOVARE da escludere.'
      )
    }
  } else if (excludedDontRenew && dontRenewMatches > 0) {
    noteParts.push('Sono esclusi i servizi marcati NON RINNOVARE.')
  }

  const note = noteParts.length ? ` ${noteParts.join(' ')}` : ''
  const endNote = !truncated ? ' Non ci sono altri risultati.' : ''
  const shownLabel = grouped ? `le prime ${shown} righe` : `i primi ${shown}`

  if (requestedFirst && shown > 0) {
    return `Ti mostro i primi ${shown} risultati.${endNote}${note}`
  }

  if ((requestedMore || requestedPrevious) && rangeLabel) {
    return `Ti mostro${rangeLabel}.${endNote}${note}`
  }

  if (requestedPrevious && shown > 0) {
    return `Ti mostro i primi ${shown}.${note}`
  }

  if (requestedLimit) {
    const limitLabel =
      offset > 0 && shown > 0 ? `i risultati ${offset + 1}-${offset + shown}` : shownLabel

    return `Ho trovato ${total} ${label}${groupedNote}. Ti mostro ${limitLabel}.${note}`
  }

  if (requestedAll && truncated) {
    return `Ho trovato ${total} ${label}${groupedNote}. Ti mostro ${shownLabel}.${note}`
  }

  if (truncated) {
    return detailed
      ? `Ho trovato ${total} ${label}${groupedNote}. Ti mostro ${shownLabel} con più dettagli.${note}`
      : `Ho trovato ${total} ${label}${groupedNote}. Ti mostro ${shownLabel}.${note}`
  }

  return `Ho trovato ${total} ${label}${groupedNote}.${note}`
}

function formatServiceListItem(item, {detailed = false} = {}) {
  const countLabel = item.count > 1 ? ` (${item.count} occorrenze)` : ''
  const title = `- [${item.priorita || '—'}] ${item.servizio || '—'}${countLabel}`
  const parts = []

  const customer = [item.cliente, item.gruppo].filter(Boolean).join(' / ')
  if (customer) parts.push(customer)

  if (item.piano) {
    parts.push(`piano ${item.piano}`)
  }

  const isSupplierExpiryResult = /\bscadenza fornitore\b/i.test(String(item.motivo || ''))

  if (isSupplierExpiryResult && item.scadenzaFornitore) {
    parts.push(`scadenza fornitore ${formatDate(item.scadenzaFornitore)}`)
  } else if (item.scadenzaScaduta) {
    parts.push(`scaduto il ${formatDate(item.scadenzaScaduta)}`)
  } else if (item.scadenzaFormattata) {
    parts.push(`scadenza ${item.scadenzaFormattata}`)
  }

  if (item.spazio?.quota && (item.spazio.isFull || item.spazio.isLow)) {
    parts.push(`spazio ${formatSpaceStatus(item.spazio)}`)
  }

  if (item.hasPlesk) {
    parts.push('Plesk collegato')
  } else if (item.hasPlesk === false) {
    parts.push('Plesk non collegato')
  }

  const flags = formatServiceListFlags(item)
  if (flags) parts.push(flags)

  const reason = formatServiceListReason(item)
  if (reason) {
    parts.push(reason)
  }

  if (!detailed) {
    return `${title}: ${parts.join(' | ')}`
  }

  const details = [
    `  Cliente: ${item.cliente || '—'}${item.gruppo ? ` | Gruppo: ${item.gruppo}` : ''}`,
    item.tipologie?.length ? `  Tipologie: ${item.tipologie.join(', ')}` : null,
    item.piani?.length ? `  Piani: ${formatServiceListPlans(item.piani)}` : null,
    item.scadenzaFormattata ? `  Scadenza cliente: ${item.scadenzaFormattata}` : null,
    item.scadenzaFornitore ? `  Scadenza fornitore: ${formatDate(item.scadenzaFornitore)}` : null,
    item.invoiceDate ? `  Fatturazione: ${formatDate(item.invoiceDate)}` : null,
    item.spazio?.quota ? `  Spazio: ${formatSpaceStatus(item.spazio)}` : null,
    `  Plesk: ${item.hasPlesk ? 'collegato' : 'non collegato'}`,
    `  Record dominio: ${item.hasDomainRecord ? 'presente' : 'assente'}`,
    `  Piani Plesk: ${item.pleskPlansSync ? 'sincronizzati' : 'non sincronizzati'}`,
    flags ? `  Flag: ${flags}` : null,
    item.fornitori?.length ? `  Fornitori: ${item.fornitori.join(', ')}` : null,
    item.totalTraffic ? `  Traffico: ${formatBytes(item.totalTraffic)}` : null,
    item.lastCommunicationDate
      ? `  Ultima comunicazione: ${formatDateTime(item.lastCommunicationDate)}`
      : null,
    reason ? `  Motivo: ${reason}` : null,
  ].filter(Boolean)

  return [title, ...details].join('\n')
}

function formatServiceListReason(item = {}) {
  const reason = String(item.motivo || '').trim()
  if (!reason) return ''

  const normalized = reason.toLowerCase()

  if (
    item.scadenzaFormattata &&
    normalized === `scadenza ${item.scadenzaFormattata}`.toLowerCase()
  ) {
    return ''
  }

  if (
    item.scadenzaScaduta &&
    normalized === `scaduto il ${formatDate(item.scadenzaScaduta)}`.toLowerCase()
  ) {
    return ''
  }

  if ((item.spazio?.isFull || item.spazio?.isLow) && normalized.startsWith('spazio ')) {
    return ''
  }

  return reason
}

function formatServiceListPlans(plans = []) {
  return plans
    .map(plan => {
      const parts = []

      parts.push(plan.name || 'piano non indicato')
      if (plan.supplier) parts.push(`fornitore ${plan.supplier}`)
      if (plan.missingPrice) parts.push('prezzo mancante')

      return parts.join(' | ')
    })
    .join('; ')
}

function formatServiceListFlags(item = {}) {
  const flags = []

  if (item.autoRenew) flags.push('rinnovo automatico')
  if (item.dontRenew) flags.push('NON RINNOVARE')
  if (item.toRenew) flags.push('DA RINNOVARE')
  if (item.toTransfer) flags.push('DA TRASFERIRE')

  return flags.join(', ')
}

function buildFastSummaryReply(payload) {
  const summary = payload?.summary || {}
  const panelCounts = payload?.panelCounts || null

  if (panelCounts && panelCounts.all !== null && panelCounts.tableAll !== null) {
    return [
      'Ecco il riepilogo rapido dei rinnovi.',
      '',
      `Servizi totali: ${panelCounts.all} (${panelCounts.tableAll} rinnovabili)`,
      `Rinnovi imminenti: ${panelCounts.renewal ?? '—'}`,
      `Rinnovi automatici: ${panelCounts.autoRenew ?? '—'}`,
      `Spazio esaurito: ${panelCounts.fullSpace ?? '—'}`,
      `Spazio in esaurimento: ${panelCounts.lowSpace ?? '—'}`,
      `Fornitori: ${panelCounts.providers ?? '—'}`,
      `Fatturazione: ${panelCounts.billing ?? '—'}`,
      `Non rinnovare: ${panelCounts.dontRenew ?? '—'}`,
    ].join('\n')
  }

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

function groupRepeatedItemsForReply(items = []) {
  return groupByKey(
    items,
    item =>
      [
        item.tipo || '',
        item.priorita || '',
        item.servizio || '',
        item.cliente || '',
        item.gruppo || '',
        item.msg || '',
      ].join('|'),
    item => ({
      ...item,
      count: 1,
    }),
    existing => ({
      ...existing,
      count: existing.count + 1,
    })
  )
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
    'to-renew': {
      empty: 'Non risultano servizi marcati DA RINNOVARE.',
      found: 'servizi da rinnovare',
    },
    'to-transfer': {
      empty: 'Non risultano servizi marcati DA TRASFERIRE.',
      found: 'servizi da trasferire',
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

  if (payload?.type === 'latest-space-full' && items.length === 1) {
    const item = items[0]
    const detectedAt = item.rilevatoIl ? ` Rilevazione disponibile: ${formatDateTime(item.rilevatoIl)}.` : ''
    return `L’ultimo servizio rilevato con spazio esaurito è ${item.servizio} (${item.cliente || 'cliente non disponibile'}): ${item.msg}.${detectedAt}`
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
          const typeLabel = item.typeLabel || 'Comunicazione'

          return `${formatDateTime(item.communicationDate)} (${typeLabel})`
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

function formatTraffic(traffic = {}) {
  const totalTraffic = formatBytes(traffic.totalTraffic || 0)
  const days = traffic.aggregationCount || null

  return days ? `${totalTraffic} su ${days} rilevazioni` : totalTraffic
}
