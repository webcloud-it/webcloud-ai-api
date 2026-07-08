import {getClientSubscriptions, isLowOnSpace} from './snapshots.js'

export function buildTodoPayloadFromServices({
  services = [],
  settings = {},
  customerId = null,
  groupId = null,
  serviceId = null,
  limit = 20,
} = {}) {
  const analysisPeriod = Number(settings.analysis_period ?? 30)
  const thresholds = settings.renewals_low_thresholds || []
  const now = new Date()
  const todos = []

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

  for (const s of filtered) {
    const serviceName = s?.name || '—'
    const customerName = s?.customer?.name || '—'
    const groupName = s?.customer?.group?.name || null

    for (const sub of getClientSubscriptions(s)) {
      if (!sub.endsOn) continue

      const d = new Date(sub.endsOn)
      const days = (d - now) / 864e5

      if (days >= 0 && days <= 7) {
        todos.push({
          tipo: 'rinnovo',
          priorita: 'alta',
          servizio: serviceName,
          cliente: customerName,
          gruppo: groupName,
          msg: `Rinnovo urgente entro ${d.toISOString().split('T')[0]}`,
        })
      } else if (days > 7 && days <= analysisPeriod) {
        todos.push({
          tipo: 'rinnovo',
          priorita: 'media',
          servizio: serviceName,
          cliente: customerName,
          gruppo: groupName,
          msg: `Rinnovo entro ${d.toISOString().split('T')[0]}`,
        })
      }
    }

    const used = Number(s?.pleskDomain?.statsDiskUsage?.totalSize || 0)
    const quota = Number(s?.pleskDomain?.statsDiskUsage?.quota || 0)

    if (quota > 0) {
      const percent = (used / quota) * 100

      if (percent >= 100) {
        todos.push({
          tipo: 'upgrade',
          priorita: 'alta',
          servizio: serviceName,
          cliente: customerName,
          gruppo: groupName,
          msg: 'Spazio esaurito',
        })
      } else if (isLowOnSpace(quota, percent, thresholds)) {
        todos.push({
          tipo: 'upgrade',
          priorita: 'media',
          servizio: serviceName,
          cliente: customerName,
          gruppo: groupName,
          msg: `Spazio in esaurimento (${percent.toFixed(1)}%)`,
        })
      }
    }

    if (s.dontRenew) {
      todos.push({
        tipo: 'verifica',
        priorita: 'media',
        servizio: serviceName,
        cliente: customerName,
        gruppo: groupName,
        msg: 'Servizio marcato NON RINNOVARE',
      })
    }

    if (s.dontRenew && s.autoRenew) {
      todos.push({
        tipo: 'anomalia',
        priorita: 'alta',
        servizio: serviceName,
        cliente: customerName,
        gruppo: groupName,
        msg: 'Servizio con NON RINNOVARE e RINNOVO AUTOMATICO attivi',
      })
    }
  }

  const priorityOrder = {
    alta: 1,
    media: 2,
    bassa: 3,
  }

  const sorted = todos.sort((a, b) => {
    return (priorityOrder[a.priorita] || 99) - (priorityOrder[b.priorita] || 99)
  })

  const items = sorted.slice(0, limit)

  return {
    type: 'todo',
    analysisPeriod,
    totale: sorted.length,
    items,
    todo: items,
  }
}
