import {filterCommunicationsByScope} from './communications.js'

export function buildChatContextFromSnapshots({
  snapshots = [],
  customerId = null,
  groupId = null,
  analysisPeriod = 30,
  communications = [],
}) {
  const total = snapshots.length
  const expiring = snapshots.filter(s => s.expiringCount > 0)
  const urgent = snapshots.filter(s => s.urgentRenewalsCount > 0)
  const full = snapshots.filter(s => s.isFull)
  const low = snapshots.filter(s => s.isLow && !s.isFull)
  const dontRenew = snapshots.filter(s => s.dontRenew)
  const anomalies = snapshots.filter(s => s.dontRenew && s.autoRenew)

  const todo = [
    ...full.map(s => ({
      tipo: 'upgrade',
      priorita: 'alta',
      servizio: s.name,
      cliente: s.customerName,
      gruppo: s.groupName,
      msg: 'Spazio esaurito',
    })),
    ...urgent.map(s => ({
      tipo: 'rinnovo',
      priorita: 'alta',
      servizio: s.name,
      cliente: s.customerName,
      gruppo: s.groupName,
      msg: `Rinnovo urgente${s.nextRenewalDate ? ` entro ${s.nextRenewalDate}` : ''}`,
    })),
    ...low.map(s => ({
      tipo: 'upgrade',
      priorita: 'media',
      servizio: s.name,
      cliente: s.customerName,
      gruppo: s.groupName,
      msg: `Spazio in esaurimento (${s.percent.toFixed(1)}%)`,
    })),
    ...dontRenew.map(s => ({
      tipo: 'verifica',
      priorita: 'media',
      servizio: s.name,
      cliente: s.customerName,
      gruppo: s.groupName,
      msg: 'Servizio marcato NON RINNOVARE',
    })),
    ...anomalies.map(s => ({
      tipo: 'anomalia',
      priorita: 'alta',
      servizio: s.name,
      cliente: s.customerName,
      gruppo: s.groupName,
      msg: 'Servizio con NON RINNOVARE e RINNOVO AUTOMATICO attivi',
    })),
  ].slice(0, 20)

  const text =
    `Servizi totali: ${total}\n` +
    `Rinnovi imminenti: ${expiring.length}\n` +
    `Rinnovi urgenti: ${urgent.length}\n` +
    `Spazio esaurito: ${full.length}\n` +
    `Spazio in esaurimento: ${low.length}\n` +
    `Non rinnovare: ${dontRenew.length}\n` +
    `Anomalie: ${anomalies.length}`

  const recentCommunications = filterCommunicationsByScope(communications, {customerId, groupId})
    .sort((a, b) => {
      const da = a?.communicationDate ? new Date(a.communicationDate).getTime() : 0
      const db = b?.communicationDate ? new Date(b.communicationDate).getTime() : 0
      return db - da
    })
    .slice(0, 5)
    .map(item => ({
      communicationDate: item.communicationDate,
      type: item.type,
      serviceName: item.serviceName,
      customerName: item.customerName,
      groupName: item.groupName,
    }))

  return {
    scope: {
      customerId: customerId || null,
      groupId: groupId || null,
    },
    analysisPeriod,
    summary: {
      total,
      expiring: expiring.length,
      urgent: urgent.length,
      full: full.length,
      low: low.length,
      dontRenew: dontRenew.length,
      anomalies: anomalies.length,
    },
    todo,
    recentCommunications,
    text,
  }
}
