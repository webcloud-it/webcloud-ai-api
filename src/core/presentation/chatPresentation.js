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
      badge: text(item.status, 'unknown'),
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

function renewalsPresentation(data) {
  if (!RENEWALS_LIST_TYPES.has(data.type) || !Array.isArray(data.items)) return null
  return list('Risultati CRM e rinnovi', data.items.map((item, index) => ({
    id: text(item.id || `${data.type}-${index + 1}`),
    title: text(item.servizio || item.name || item.label || item.dominio || item.id, 'Risultato'),
    subtitle: compact([item.cliente || item.customer, item.gruppo || item.group]).join(' · '),
    badge: text(item.priorita || item.tipo),
    details: [detail('Dettaglio', item.msg || item.message), detail('Scadenza', item.scadenza || item.end_date)].filter(Boolean),
  })), data.totale ?? data.total)
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
  return proposalPresentation(data) || sendInItalyPresentation(data) || webcamPresentation(data) || renewalsPresentation(data)
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
