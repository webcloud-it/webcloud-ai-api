import {normalizeText} from './intents.js'

export function buildCommunicationsIndex(services = []) {
  return services.flatMap(service => {
    const customerName = service?.customer?.name || '—'
    const groupName = service?.customer?.group?.name || null
    const serviceName = service?.name || '—'

    return (service?.renewalsCommunications || [])
      .filter(item => item?.communicationDate)
      .map(item => ({
        serviceId: service.id,
        serviceName,
        customerId: service?.customer?.id || null,
        customerName,
        groupId: service?.customer?.group?.id || null,
        groupName,
        type: item?.type || null,
        communicationDate: item.communicationDate,
      }))
  })
}

export function extractNamedTarget(message = '') {
  const text = String(message || '').trim()

  const quoted = text.match(/["“”']([^"“”']{2,})["“”']/)
  if (quoted?.[1]) return quoted[1].trim()

  const cleaned = text
    .replace(
      /\b(quando|qual[ea]?[i]?|ultima|ultimo|ultime|ultimi|mail|email|comunicazione|comunicazioni|inviata|inviato|inviate|spedita|spedito|mandata|mandato|a|ad|del|della|dei|delle|per|su|di|fammi|dimmi|mostrami)\b/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned.length >= 2 ? cleaned : null
}

export function filterCommunicationsByScope(items = [], {customerId = null, groupId = null} = {}) {
  let out = items

  if (customerId) {
    out = out.filter(item => String(item.customerId) === String(customerId))
  }

  if (groupId) {
    out = out.filter(item => String(item.groupId) === String(groupId))
  }

  return out
}

export function filterCommunicationsByTarget(items = [], target = null) {
  if (!target) return items

  const q = normalizeText(target)

  return items.filter(item => {
    return (
      normalizeText(item?.serviceName).includes(q) ||
      normalizeText(item?.customerName).includes(q) ||
      normalizeText(item?.groupName).includes(q)
    )
  })
}

export function buildCommunicationsContext({
  services = [],
  customerId = null,
  groupId = null,
  message = '',
}) {
  const allCommunications = buildCommunicationsIndex(services)

  const scoped = filterCommunicationsByScope(allCommunications, {customerId, groupId})
  const target = extractNamedTarget(message)
  const matched = filterCommunicationsByTarget(scoped, target)

  const ordered = [...matched].sort((a, b) => {
    const da = a?.communicationDate ? new Date(a.communicationDate).getTime() : 0
    const db = b?.communicationDate ? new Date(b.communicationDate).getTime() : 0
    return db - da
  })

  const latest = ordered[0] || null

  return {
    scope: {
      customerId: customerId || null,
      groupId: groupId || null,
    },
    target: target || null,
    totalCommunications: ordered.length,
    latestCommunication: latest
      ? {
          communicationDate: latest.communicationDate,
          type: latest.type,
          serviceName: latest.serviceName,
          customerName: latest.customerName,
          groupName: latest.groupName,
        }
      : null,
    items: ordered.slice(0, 15).map(item => ({
      communicationDate: item.communicationDate,
      type: item.type,
      serviceName: item.serviceName,
      customerName: item.customerName,
      groupName: item.groupName,
    })),
  }
}
