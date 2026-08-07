import {normalizeText} from '../../../utils/text.js'
import {getCampaigns, getCampaignStats, getUsers} from './service.js'

function extractQuotedValue(message = '') {
  return String(message).match(/["“”']([^"“”']{2,80})["“”']/)?.[1]?.trim() || ''
}

function parseMode(text = '') {
  if (/oggi|odiern/.test(text)) return 'today'
  if (/7 giorni|settimana/.test(text)) return 'last_7_days'
  if (/365 giorni|ultimo anno/.test(text)) return 'last_365_days'
  if (/anno corrente|quest.?anno/.test(text)) return 'current_year'
  if (/coda|queued|in attesa/.test(text)) return 'queued'
  if (/in corso|invio/.test(text)) return 'in_process'
  return 'last_30_days'
}

function formatCampaigns(payload = {}) {
  const items = Array.isArray(payload.data) ? payload.data : []
  const total = payload.meta?.total ?? items.length

  if (!items.length) return 'Non ho trovato campagne corrispondenti.'

  const lines = items.slice(0, 20).map((item, index) => {
    const customer = item.customer_name ? ` — ${item.customer_name}` : ''
    const status = item.status ? ` [${item.status}]` : ''
    const sentAt = item.sent_at ? ` — ${String(item.sent_at).slice(0, 10)}` : ''
    return `${index + 1}. ${item.name || item.subject || item.id}${customer}${status}${sentAt}`
  })

  return [`Ho trovato ${total} campagne.`, ...lines].join('\n')
}

function formatUsers(payload = {}) {
  const items = Array.isArray(payload.data) ? payload.data : []
  const total = payload.meta?.total ?? payload.meta?.total_rows ?? items.length

  if (!items.length) return 'Non ho trovato utenti Send in Italy corrispondenti.'

  const lines = items.slice(0, 20).map((item, index) => {
    const plan = item.plan?.name || item.plan_name || item.subscription_plan || null
    const contacts = item.total_contacts ?? item.contacts_count ?? null
    return `${index + 1}. ${item.company_name || item.name || item.id}${plan ? ` — piano ${plan}` : ''}${contacts !== null ? ` — ${contacts} contatti` : ''}`
  })

  return [`Ho trovato ${total} utenti Send in Italy.`, ...lines].join('\n')
}

function collectScalarEntries(value, prefix = '', output = []) {
  if (!value || typeof value !== 'object') return output

  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue
    const label = prefix ? `${prefix}.${key}` : key

    if (['string', 'number', 'boolean'].includes(typeof item)) {
      output.push([label, item])
    } else if (!Array.isArray(item) && output.length < 20) {
      collectScalarEntries(item, label, output)
    }
  }

  return output
}

function formatStats(payload = {}, mode) {
  const source = payload.data && !Array.isArray(payload.data) ? payload.data : payload
  const entries = collectScalarEntries(source).slice(0, 15)

  if (!entries.length) {
    return `Non risultano statistiche disponibili per il periodo ${mode}.`
  }

  return [
    `Statistiche Send in Italy (${mode}):`,
    ...entries.map(([key, value]) => `- ${key.replaceAll('_', ' ')}: ${value}`),
  ].join('\n')
}

export async function handleSendInItalyChat({message, token} = {}) {
  const text = normalizeText(message)
  const search = extractQuotedValue(message)

  if (/statistic|performance|apert|click|consegn|bounce|invii/.test(text)) {
    const mode = parseMode(text)
    const payload = await getCampaignStats({token, mode})

    return {
      ok: true,
      intent: 'sendinitaly-stats',
      source: 'tool-fast',
      reply: formatStats(payload, mode),
      data: {type: 'sendinitaly-stats', mode, payload},
      meta: {moduleId: 'facile.sendinitaly'},
    }
  }

  if (/utent|account|aziend|client|piano/.test(text) && !/campagn/.test(text)) {
    const payload = await getUsers({token, search})

    return {
      ok: true,
      intent: 'sendinitaly-users',
      source: 'tool-fast',
      reply: formatUsers(payload),
      data: {type: 'sendinitaly-users', query: {search}, ...payload},
      meta: {moduleId: 'facile.sendinitaly'},
    }
  }

  const status = /in corso/.test(text)
    ? 'in_process'
    : /in coda|queued/.test(text)
      ? 'queued'
      : /inviat/.test(text)
        ? 'sent'
        : ''
  const payload = await getCampaigns({token, search, status})

  return {
    ok: true,
    intent: 'sendinitaly-campaigns',
    source: 'tool-fast',
    reply: formatCampaigns(payload),
    data: {type: 'sendinitaly-campaigns', query: {search, status}, ...payload},
    meta: {moduleId: 'facile.sendinitaly'},
  }
}

