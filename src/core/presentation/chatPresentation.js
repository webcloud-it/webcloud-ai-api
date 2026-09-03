const RENEWALS_LIST_TYPES = new Set([
  'search',
  'space-full',
  'space-low',
  'dont-renew',
  'to-renew',
  'to-transfer',
  'anomalies',
  'critical-services',
  'service-list',
])

function text(value, fallback = '') {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return fallback
  return String(value).trim().slice(0, 300)
}

function compact(values = []) {
  return values.map(value => text(value)).filter(Boolean)
}

function detail(label, value) {
  const normalized = text(value)
  return normalized ? {label, value: normalized} : null
}

function list(title, cards, total = cards.length) {
  return {
    version: 1,
    kind: 'list',
    title,
    total: Number.isFinite(Number(total)) ? Number(total) : cards.length,
    cards: cards.slice(0, 10),
  }
}

function sendInItalyPresentation(data) {
  const items = Array.isArray(data.data) ? data.data : []
  if (data.type === 'sendinitaly-support-tickets' && Array.isArray(data.items)) {
    return list(
      'Ticket assistenza Send in Italy',
      data.items.map(ticket => ({
        id: text(ticket.id),
        title: text(`#${ticket.number || ticket.id} ${ticket.title}`, 'Ticket'),
        subtitle: text(ticket.customerName),
        badge: text(ticket.state),
        details: [
          detail('Categoria', ticket.category),
          detail('CRM', ticket.crmCustomerId),
          detail('Sviluppo', ticket.clickupLinked ? 'ClickUp collegato' : null),
          detail('Aggiornato', String(ticket.updatedAt || '').slice(0, 16).replace('T', ' ')),
        ].filter(Boolean),
        action: {
          id: 'navigate',
          label: 'Apri assistenza',
          path: '/sendinitaly/support',
          query: ticket.customerId ? {customer_id: text(ticket.customerId)} : {},
        },
      })),
      data.meta?.total
    )
  }

  if (data.type === 'sendinitaly-campaigns') {
    return list('Campagne Send in Italy', items.map(item => ({
      id: text(item.id),
      title: text(item.name || item.subject || item.id, 'Campagna'),
      subtitle: text(item.customer_name),
      badge: text(item.status),
      details: [detail('Invio', String(item.sent_at || '').slice(0, 10))].filter(Boolean),
    })), data.meta?.total)
  }

  if (data.type === 'sendinitaly-users') {
    return list('Utenti Send in Italy', items.map(item => {
      const id = text(item.id)
      return {
        id,
        title: text(item.company_name || item.name || item.id, 'Utente'),
        subtitle: text(item.plan?.name || item.plan_name || item.subscription_plan),
        details: [
          detail('Contatti', item.total_contacts ?? item.contacts_count),
          detail('Campagne', item.total_campaigns ?? item.campaigns_count),
        ].filter(Boolean),
        ...(id ? {action: {id: 'navigate', label: 'Apri utente', path: `/sendinitaly/users/${encodeURIComponent(id)}`}} : {}),
      }
    }), data.meta?.total ?? data.meta?.total_rows)
  }

  if (data.type === 'sendinitaly-stats') {
    const source = data.payload?.data && !Array.isArray(data.payload.data)
      ? data.payload.data
      : data.payload
    const metrics = Object.entries(source || {})
      .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
      .slice(0, 8)
      .map(([label, value]) => ({label: label.replaceAll('_', ' '), value: text(value)}))
    return metrics.length ? {version: 1, kind: 'metrics', title: 'Statistiche Send in Italy', metrics} : null
  }

  if (data.type === 'sendinitaly-plans' && Array.isArray(data.items)) {
    return list('Piani Send in Italy', data.items.map(item => ({
      id: text(item.id || item.name),
      title: text(item.name, 'Piano'),
    })), data.items.length)
  }

  if (data.type === 'sendinitaly-user-detail' && data.user) {
    const user = data.user
    const metrics = [
      ['Piano', user.plan || 'non configurato'],
      ['CRM', user.crmLinked ? 'collegato' : 'da collegare'],
      ['Accesso Light', user.lightAccessDisabled ? 'disabilitato' : 'attivo'],
      ['Contatti', user.counts?.contacts ?? 0],
      ['Campagne', user.counts?.campaigns ?? 0],
      ['Liste', user.counts?.lists ?? 0],
      ['Mittenti', user.counts?.senders ?? 0],
    ].map(([label, value]) => ({label, value: text(value)}))
    return {version: 1, kind: 'metrics', title: text(user.companyName, 'Utente Send in Italy'), metrics}
  }

  if (data.type === 'sendinitaly-dns-status' && Array.isArray(data.items)) {
    return list(`DNS · ${text(data.user?.companyName, 'Send in Italy')}`, data.items.map(item => ({
      id: text(item.domain),
      title: text(item.domain, 'Dominio'),
      subtitle: text(item.companyName),
      badge: text(item.status, 'unknown'),
      action: item.userId ? {type: 'navigate', label: 'Apri utente', path: `/sendinitaly/users/${encodeURIComponent(text(item.userId))}`} : undefined,
      details: [
        detail('SPF', item.checks?.spf ? 'OK' : 'da verificare'),
        detail('Click', item.checks?.click2 ? 'OK' : 'da verificare'),
        detail('Return path', item.checks?.ss1rp ? 'OK' : 'da verificare'),
      ].filter(Boolean),
    })), data.items.length)
  }

  return null
}

function webcamPresentation(data) {
  if (data.type === 'webcam-summary') {
    const summary = data.summary || {}
    const fields = [
      ['Totali', summary.total],
      ['Online', summary.online],
      ['Offline', summary.offline],
      ['Stream non online', summary.streamOffline],
      ['Snapshot non online', summary.snapshotOffline],
      ['Problemi connettività', summary.connectivityProblems],
      ['MikroTik non online', summary.mikrotikOffline],
      ['Downtime attivi', summary.activeDowntime],
    ]
    return {version: 1, kind: 'metrics', title: 'Stato WebcamGo', metrics: fields.map(([label, value]) => ({label, value: text(value ?? 0)}))}
  }

  if (data.type !== 'webcam-list' || !Array.isArray(data.items)) return null
  return list('WebcamGo', data.items.map(item => {
    const slug = text(item.slug)
    return {
      id: text(item.id),
      title: text(item.name || item.slug || item.id, 'Webcam'),
      subtitle: compact([item.location, item.reseller]).join(' · '),
      badge: text(item.status?.overall || 'unknown'),
      details: [
        detail('Stream', item.status?.stream?.status),
        detail('Snapshot', item.status?.snapshot?.status),
        detail('Connettività', item.status?.connectivity?.status),
      ].filter(Boolean),
      ...(slug ? {action: {id: 'navigate', label: 'Apri webcam', path: `/webcamgo/webcams/${encodeURIComponent(slug)}`}} : {}),
    }
  }), data.totale)
}

function asiagoPresentation(data) {
  if (data.type === 'asiago-summary') {
    const totals = data.totals || {}
    return {
      version: 1,
      kind: 'metrics',
      title: 'Asiago.it e CMS',
      metrics: [
        {label: 'Eventi futuri', value: text(totals.upcomingEvents ?? 0)},
        {label: 'Altri contenuti', value: text(totals.contents ?? 0)},
        {label: 'Minisiti', value: text(totals.minisites ?? 0)},
      ],
    }
  }

  if (data.type === 'asiago-minisites' && Array.isArray(data.items)) {
    return list('Minisiti Asiago.it', data.items.map(item => {
      const id = text(item.id)
      return {
        id,
        title: text(item.name, 'Minisito'),
        subtitle: text(item.category?.name),
        ...(id ? {action: {id: 'navigate', label: 'Apri minisito', path: `/asiagoit/minisites/${encodeURIComponent(id)}`}} : {}),
      }
    }), data.total)
  }

  if (data.type === 'asiago-snow-resorts' && Array.isArray(data.items)) {
    return list('Bollettino neve', data.items.map(item => ({
      id: text(item.id),
      title: text(item.name, 'Comprensorio'),
      subtitle: text(item.location),
      badge: item.portalVisible ? 'portale attivo' : 'portale non attivo',
      details: [
        detail('Ultimo aggiornamento', item.updatedOn),
        detail('Notifiche', item.notificationsEnabled ? 'attive' : 'disattive'),
        detail('Integrazioni', `${item.integrations?.enabled ?? 0}/${item.integrations?.total ?? 0} attive`),
      ].filter(Boolean),
    })), data.total)
  }

  if (data.type === 'asiago-pricelists' && Array.isArray(data.items)) {
    return list('Listini Asiago.it', data.items.map(item => ({id: text(item.id), title: text(item.name, 'Struttura')})), data.total)
  }

  if (data.type === 'asiago-redirects' && Array.isArray(data.items)) {
    return list('Redirect Asiago.it', data.items.map(item => ({
      id: text(item.id),
      title: text(item.fromPath, 'Origine non disponibile'),
      subtitle: text(item.toUrl),
      badge: item.autogenerated ? 'automatico' : 'manuale',
      details: [detail('Visite', item.visits ?? 0)].filter(Boolean),
    })), data.total)
  }

  if (['asiago-events', 'asiago-event-detail', 'asiago-contents', 'asiago-content-detail'].includes(data.type) && Array.isArray(data.items)) {
    const isEvent = data.type.includes('event')
    return list(isEvent ? 'Eventi Asiago.it' : 'Contenuti Asiago.it', data.items.map(item => {
      const id = text(item.id)
      return {
        id,
        title: text(item.title, isEvent ? 'Evento' : 'Contenuto'),
        subtitle: text(item.subtitle),
        badge: item.published ? 'pubblicato' : 'bozza',
        details: [
          detail('Data', item.event?.startDate),
          detail('Autore', item.author),
        ].filter(Boolean),
        ...(isEvent && id ? {action: {id: 'navigate', label: 'Apri evento', path: `/asiagoit/events/${encodeURIComponent(id)}`}} : {}),
      }
    }), data.total)
  }

  return null
}

function renewalsPresentation(data) {
  if (!RENEWALS_LIST_TYPES.has(data.type) || !Array.isArray(data.items)) return null
  const filterKinds = new Set(
    (Array.isArray(data.query?.filters) ? data.query.filters : [])
      .map(filter => filter?.kind)
      .filter(Boolean)
  )
  const serviceListUsesSupplierExpiry =
    data.type === 'service-list' && filterKinds.has('supplier-expires-in-range')

  return list('Risultati CRM e rinnovi', data.items.map((item, index) => ({
    id: text(item.id || `${data.type}-${index + 1}`),
    title: text(item.servizio || item.name || item.label || item.dominio || item.id, 'Risultato'),
    subtitle: compact([item.cliente || item.customer, item.gruppo || item.group]).join(' · '),
    badge: text(item.priorita || item.tipo),
    details: [
      detail('Dettaglio', item.msg || item.message),
      serviceListUsesSupplierExpiry
        ? detail('Scadenza fornitore', item.scadenzaFornitore) ||
          detail('Scadenza', item.scadenza || item.end_date)
        : data.type === 'service-list'
          ? detail('Scadenza', item.scadenza || item.end_date) ||
            detail('Scadenza fornitore', item.scadenzaFornitore)
          : item.scadenzaFornitore
            ? detail('Scadenza fornitore', item.scadenzaFornitore)
            : detail('Scadenza', item.scadenza || item.end_date),
    ].filter(Boolean),
  })), data.totale ?? data.total)
}

function webcloudPresentation(data) {
  if (data.type === 'webcloud-operational-overview' && Array.isArray(data.sources)) {
    return list('Panoramica operativa', data.sources.map(source => ({
      id: text(source.id),
      title: text(source.label, 'Area'),
      subtitle: source.ok ? `${source.alerts?.length || 0} segnalazioni` : text(source.unavailable ? 'non autorizzata' : 'non disponibile'),
      badge: source.ok ? (source.alerts?.some(item => item.level === 'high') ? 'attenzione' : source.alerts?.length ? 'avvisi' : 'ok') : 'non verificata',
      details: Object.entries(source.metrics || {}).slice(0, 6).map(([label, value]) => detail(overviewMetricLabel(source.id, label), value)).filter(Boolean),
      ...(source.action ? {action: source.action} : {}),
    })), data.sources.length)
  }

  if (data.type === 'webcloud-chat-audit') {
    return {
      version: 1,
      kind: 'metrics',
      title: 'Stato chatbot (ultima ora)',
      metrics: [
        {label: 'Richieste', value: text(data.requests ?? 0)},
        {label: 'Riuscite', value: text(`${data.successRate ?? 100}%`)},
        {label: 'Errori', value: text(data.failures ?? 0)},
        {label: 'Media', value: text(`${data.averageDurationMs ?? 0} ms`)},
        {label: 'Lente', value: text(data.slowRequests ?? 0)},
      ],
    }
  }

  if (data.type === 'webcloud-cache-buckets' && Array.isArray(data.items)) {
    return list('Cache Cloudflare', data.items.map(item => ({
      id: text(item.name), title: text(item.name, 'Bucket'), subtitle: text(item.pattern),
      details: [detail('Browser max age', item.browserMaxAge), detail('CDN max age', item.cdnMaxAge), detail('Aggiornato', item.timestamp ? new Date(item.timestamp).toISOString().slice(0, 16).replace('T', ' ') : null)].filter(Boolean),
    })), data.total)
  }
  if (data.type === 'webcloud-holidays' && Array.isArray(data.items)) {
    return list('Calendario festività', data.items.map(item => ({
      id: text(item.id), title: text(item.name, 'Ricorrenza'), badge: text(item.type),
      details: [detail('Dal', item.from), detail('Al', item.to)].filter(Boolean),
    })), data.total)
  }
  if (data.type === 'webcloud-automations' && Array.isArray(data.items)) {
    return list('Automazioni', data.items.map(item => ({
      id: text(item.id), title: text(item.name, 'Automazione'), subtitle: text(item.description), badge: item.runnable ? 'eseguibile' : 'senza trigger',
      details: [detail('Input', item.inputs?.length ?? 0)].filter(Boolean),
      ...(item.id ? {action: {id: 'navigate', label: 'Apri automazione', path: `/webcloud/mattemations/${encodeURIComponent(String(item.id))}`}} : {}),
    })), data.total)
  }
  if (data.type === 'webcloud-wam-applications' && Array.isArray(data.items)) {
    return list('Applicazioni WAM', data.items.map(item => ({
      id: text(item.id), title: text(item.name, 'Applicazione'),
      ...(item.id ? {action: {id: 'navigate', label: 'Apri applicazione', path: `/webcloud/assets-manager/${encodeURIComponent(String(item.id))}`}} : {}),
    })), data.total)
  }
  if (data.type === 'webcloud-wam-assets' && Array.isArray(data.items)) {
    return list('Asset WAM', data.items.map(item => ({
      id: text(item.id || item.shortId), title: text(item.title, 'Asset'), subtitle: text(item.shortId), badge: text(item.type || item.mimetype),
      details: [detail('Dimensioni', item.width && item.height ? `${item.width}×${item.height}` : null)].filter(Boolean),
      ...(item.applicationId && item.shortId ? {action: {id: 'navigate', label: 'Apri asset', path: `/webcloud/assets-manager/${encodeURIComponent(String(item.applicationId))}/assets`, query: {asset: String(item.shortId)}}} : {}),
    })), data.total)
  }
  return null
}

function overviewMetricLabel(sourceId, key) {
  const labels = {
    total: 'Totale', expiring: 'In scadenza', urgent: 'Urgenti', full: 'Spazio esaurito', low: 'Spazio in esaurimento',
    online: 'Online', unexpectedOffline: 'Offline fuori downtime', streamOffline: 'Stream non online', connectivityProblems: 'Problemi connettività', mikrotikOffline: 'MikroTik non online',
    queued: 'In coda', inProcess: 'In corso', requests: 'Richieste', successRate: 'Riuscite (%)', averageDurationMs: 'Media (ms)', failures: 'Errori', slowRequests: 'Richieste lente',
  }
  return labels[key] || `${sourceId || ''} ${key}`.trim()
}

function proposalPresentation(data) {
  if (!['action-proposal', 'action-preview', 'action-confirmation'].includes(data.type)) return null
  const action = data.action && typeof data.action === 'object' ? data.action : data
  if (action.requiresConfirmation === false || data.confirmationRequired === false) return null
  const target = action.target || data.target || {}
  const targetLabel = text(target.label || target.name || target.slug || target.id)
  const changes = Array.isArray(action.changes)
    ? action.changes.slice(0, 10).map(change => ({
        label: text(change.label || change.field, 'Modifica'),
        from: text(change.from ?? change.before ?? '—'),
        to: text(change.to ?? change.after ?? change.value ?? '—'),
      }))
    : []
  const operation = text(data.operation || action.tool || action.kind, 'operazione')

  return {
    version: 1,
    kind: 'proposal',
    title: 'Conferma operazione',
    operation,
    target: targetLabel,
    changes,
    expiresAt: text(data.expiresAt || action.expiresAt),
    actions: [
      {id: 'send-message', label: 'Conferma', message: 'confermo', variant: 'danger'},
      {id: 'send-message', label: 'Annulla', message: 'annulla', variant: 'secondary'},
    ],
  }
}

export function buildChatPresentation(data = null) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  if (data.presentation?.version) return data.presentation
  return proposalPresentation(data) || asiagoPresentation(data) || webcloudPresentation(data) || sendInItalyPresentation(data) || webcamPresentation(data) || renewalsPresentation(data)
}

export function attachChatPresentation(payload = null) {
  if (!payload || typeof payload !== 'object' || !payload.data || typeof payload.data !== 'object') return payload
  const presentation = buildChatPresentation(payload.data)
  if (!presentation) return payload
  const actions = Array.isArray(payload.data.actions)
    ? payload.data.actions
    : RENEWALS_LIST_TYPES.has(payload.data.type)
      ? [{id: 'navigate', label: 'Apri pannello rinnovi', path: '/crm/renewals/panel'}]
      : null
  return {...payload, data: {...payload.data, presentation, ...(actions ? {actions} : {})}}
}
