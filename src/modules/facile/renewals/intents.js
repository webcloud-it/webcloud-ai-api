export function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .trim()
}

export function matchesText(value, q) {
  return String(value || '')
    .toLowerCase()
    .includes(String(q || '').toLowerCase())
}

export function pickCommunicationIntent(message = '') {
  const text = normalizeText(message)

  if (
    /(ultima mail|ultima email|ultima comunicazione|ultime comunicazioni|quando.*(mail|email|comunicazione)|mail inviata|email inviata|comunicazione inviata)/i.test(
      text
    )
  ) {
    return 'communications'
  }

  return null
}

export function pickChatIntent(message = '', {customerId, groupId} = {}) {
  const text = String(message || '').toLowerCase()

  if (pickCommunicationIntent(text)) {
    return 'communications'
  }

  if (/(cerca|trova|cerco|servizio|cliente|gruppo).{0,20}["“”']?([a-z0-9._ -]{2,})/i.test(text)) {
    return 'search'
  }

  if (/(criticit|critici|anomali|anomalie|problemi principali)/i.test(text)) {
    return 'critical'
  }

  if (/(rinnovi urgenti|scadenze urgenti|in scadenza|scadenze|rinnovi)/i.test(text)) {
    return customerId ? 'customer-report' : groupId ? 'group-report' : 'summary'
  }

  if (/(cose da fare|todo|da fare|attività|azioni da fare|priorità)/i.test(text)) {
    return customerId ? 'customer-report' : groupId ? 'group-report' : 'todo'
  }

  if (customerId) return 'customer-report'
  if (groupId) return 'group-report'

  return 'summary'
}

export function extractSearchQuery(message = '') {
  const text = String(message || '').trim()

  const quoted = text.match(/["“”']([^"“”']{2,})["“”']/)
  if (quoted?.[1]) return quoted[1].trim()

  const cleaned = text
    .replace(/\b(cerca|trova|cerco|servizio|cliente|gruppo|report|fammi|mostrami|dimmi)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned.length >= 2 ? cleaned : null
}
