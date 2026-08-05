import {normalizeText} from '../../../utils/text.js'

const DOMAIN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/i

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
        typeLabel: item?.typeLabel || null,
        communicationDate: item.communicationDate,
      }))
  })
}

export function extractNamedTarget(message = '') {
  const text = String(message || '').trim()
  if (!text) return null

  const quoted = text.match(/["“”']([^"“”']{2,})["“”']/)
  if (quoted?.[1]) return cleanCommunicationTarget(quoted[1])

  const domain = text.match(DOMAIN_PATTERN)?.[0]
  if (domain) return domain

  const connectorMatch = text.match(
    /\b(?:per|su|riguardo(?:\s+a)?|relativ[ao]\s+a|del(?:la)?\s+cliente|del\s+gruppo|di)\s+(.+)$/i
  )
  const connectorTarget = cleanCommunicationTarget(connectorMatch?.[1] || '')
  if (connectorTarget && !isGenericCommunicationTarget(connectorTarget)) {
    return connectorTarget
  }

  const cleaned = cleanCommunicationTarget(
    text.replace(
      /\b(?:quando|qual(?:e|i)?|che|cosa|e|è|sono|sia|stata|stato|state|stati|la|le|il|lo|i|gli|un|una|ultima|ultimo|ultime|ultimi|piu recente|più recente|mail|email|comunicazione|comunicazioni|inviata|inviato|inviate|inviati|spedita|spedito|spedite|spediti|mandata|mandato|mandate|mandati|fammi|dimmi|mostrami|elencami)\b/gi,
      ' '
    )
  )

  return cleaned && !isGenericCommunicationTarget(cleaned) ? cleaned : null
}

function cleanCommunicationTarget(value = '') {
  return String(value || '')
    .replace(/[?.!,;:]+$/g, '')
    .replace(/^["“”']+|["“”']+$/g, '')
    .replace(/^(?:l['’]|dell['’]|all['’]|del|della|dei|delle|il|lo|la|i|gli|le|un|una)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isGenericCommunicationTarget(value = '') {
  return /^(?:mail|email|comunicazione|comunicazioni|rinnovo|rinnovi|servizio|servizi)$/i.test(
    String(value || '').trim()
  )
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
          typeLabel: latest.typeLabel,
          serviceName: latest.serviceName,
          customerName: latest.customerName,
          groupName: latest.groupName,
        }
      : null,
    items: ordered.slice(0, 15).map(item => ({
      communicationDate: item.communicationDate,
      type: item.type,
      typeLabel: item?.typeLabel || null,
      serviceName: item.serviceName,
      customerName: item.customerName,
      groupName: item.groupName,
    })),
  }
}

export function buildCommunicationsReply(payload = {}, {message = ''} = {}) {
  const items = Array.isArray(payload?.items) ? payload.items : []
  const total = Number(payload?.totalCommunications ?? items.length)
  const target = String(payload?.target || '').trim()

  if (!items.length) {
    return target
      ? `Non ho trovato comunicazioni inviate relative a "${target}".`
      : 'Non ho trovato comunicazioni inviate nei dati disponibili.'
  }

  if (wantsLatestCommunication(message)) {
    const latest = payload?.latestCommunication || items[0]
    return formatLatestCommunicationReply(latest, {target})
  }

  const shown = items.length
  const heading = target
    ? `Ho trovato ${total} comunicazioni inviate relative a "${target}".`
    : `Ho trovato ${total} comunicazioni inviate.`

  return [
    heading,
    ...(total > shown ? [`Ti mostro le prime ${shown}.`] : []),
    '',
    ...items.map(formatCommunicationListItem),
  ].join('\n')
}

function wantsLatestCommunication(message = '') {
  const text = String(message || '')
  if (/\b(?:ultime|ultimi)\b/i.test(text)) return false

  return (
    /\bultima\s+(?:mail|email|comunicazione)\b/i.test(text) ||
    /\b(?:mail|email|comunicazione)\s+pi[uù]\s+recente\b/i.test(text) ||
    /\bquando\b.{0,50}\b(?:mail|email|comunicazione)\b/i.test(text)
  )
}

function formatLatestCommunicationReply(item = {}, {target = ''} = {}) {
  const type = item?.typeLabel || (item?.type ? `tipo ${item.type}` : 'tipo non specificato')
  const subject = target || item?.serviceName || item?.customerName || 'il contesto richiesto'
  const details = [
    item?.serviceName ? `servizio ${item.serviceName}` : null,
    item?.customerName ? `cliente ${item.customerName}` : null,
    item?.groupName ? `gruppo ${item.groupName}` : null,
  ].filter(Boolean)

  return [
    `L’ultima comunicazione inviata relativa a "${subject}" risulta del ${formatCommunicationDateTime(item?.communicationDate)}.`,
    `Tipo: ${type}.`,
    ...(details.length ? [`Riferimenti: ${details.join(' | ')}.`] : []),
  ].join('\n')
}

function formatCommunicationListItem(item = {}) {
  const type = item?.typeLabel || (item?.type ? `tipo ${item.type}` : 'tipo non specificato')
  const details = [
    item?.serviceName ? `servizio ${item.serviceName}` : null,
    item?.customerName ? `cliente ${item.customerName}` : null,
    item?.groupName ? `gruppo ${item.groupName}` : null,
  ].filter(Boolean)

  return `- ${formatCommunicationDateTime(item?.communicationDate)} | ${type}${
    details.length ? ` | ${details.join(' | ')}` : ''
  }`
}

function formatCommunicationDateTime(value) {
  if (!value) return 'data non disponibile'

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)

  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

