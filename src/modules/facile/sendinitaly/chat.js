import {normalizeText} from '../../../utils/text.js'
import {
  extractEntityTarget,
  isOpenEntityRequest,
  resolveNamedEntity,
} from '../../../core/entities/entityResolver.js'
import {getCampaigns, getCampaignStats, getUser, getUserDnsStatus, getUserPlans, getUsers} from './service.js'

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

function extractUserTarget(message = '') {
  const quoted = extractQuotedValue(message)
  if (quoted) return quoted
  return String(message)
    .replace(/^.*?\b(?:utente|account|azienda|cliente)\b\s*/i, '')
    .replace(/\b(?:su send\s*in\s*italy|di send\s*in\s*italy)\b/gi, '')
    .replace(/[?.!]+$/g, '')
    .trim()
}

async function resolveUser({target, token, services}) {
  if (!target) return {status: 'missing'}
  const payload = await services.getUsers({token, search: target, limit: 20})
  const items = Array.isArray(payload?.data) ? payload.data : []
  const resolution = resolveNamedEntity({
    items,
    query: target,
    fields: [
      {value: 'id', weight: 20},
      {value: 'company_name', weight: 18},
      {value: 'name', weight: 16},
      {value: 'email', weight: 8},
    ],
  })

  if (resolution.status === 'resolved') return {status: 'resolved', item: resolution.item}
  if (resolution.status === 'ambiguous') {
    return {status: 'ambiguous', items: resolution.candidates.map(candidate => candidate.item)}
  }
  return {status: resolution.status === 'missing-target' ? 'missing' : 'not-found', items: []}
}

function userClarification(resolution, target) {
  if (resolution.status === 'missing') return 'Quale utente Send in Italy vuoi analizzare? Indica il nome azienda.'
  if (resolution.status === 'not-found') return `Non ho trovato un utente Send in Italy corrispondente a “${target}”.`
  const options = resolution.items.map((item, index) => `${index + 1}. ${item.company_name || item.name || item.id}`)
  return `Ho trovato più utenti corrispondenti:\n${options.join('\n')}\nIndica il nome esatto.`
}

function sanitizeUserDetail(raw = {}) {
  const plan = raw.subscription_config?.plan || raw.plan || {}
  const alerts = Array.isArray(raw.operational_alerts) ? raw.operational_alerts : []
  return {
    id: raw.id || null,
    companyName: raw.company_name || raw.name || '—',
    plan: plan.name || raw.plan_name || null,
    crmLinked: Boolean(raw.crm_customers_id || raw.subscription_config?.crm_customers_id),
    lightAccessDisabled: raw.light_access?.disabled === true,
    counts: {
      contacts: Number(raw.total_contacts || 0),
      campaigns: Number(raw.total_campaigns || 0),
      lists: Number(raw.total_lists || 0),
      templates: Number(raw.total_templates || 0),
      automations: Number(raw.total_automations || 0),
      senders: Number(raw.total_senders || 0),
    },
    monthlySendsUsage: raw.monthly_sends_usage && typeof raw.monthly_sends_usage === 'object'
      ? Object.fromEntries(Object.entries(raw.monthly_sends_usage).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 12))
      : null,
    senderDomains: Array.isArray(raw.sender_domains) ? raw.sender_domains.map(String).filter(Boolean).slice(0, 10) : [],
    alerts: alerts.slice(0, 10).map(item => ({type: item.type || null, level: item.level || null, label: item.label || null, message: item.message || null})),
  }
}

function formatUserDetail(user) {
  const lines = [
    `Dettaglio Send in Italy di ${user.companyName}:`,
    `- piano: ${user.plan || 'non configurato'}`,
    `- CRM: ${user.crmLinked ? 'collegato' : 'da collegare'}`,
    `- accesso Light: ${user.lightAccessDisabled ? 'disabilitato' : 'attivo'}`,
    `- contatti: ${user.counts.contacts}`,
    `- campagne: ${user.counts.campaigns}`,
    `- liste: ${user.counts.lists}`,
    `- mittenti: ${user.counts.senders}`,
  ]
  if (user.alerts.length) lines.push('Avvisi:', ...user.alerts.map(item => `- ${item.label || item.type}: ${item.message || 'verifica richiesta'}`))
  return lines.join('\n')
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

export async function handleSendInItalyChat({message, token, services = {getCampaigns, getCampaignStats, getUsers, getUserPlans, getUser, getUserDnsStatus}} = {}) {
  const text = normalizeText(message)
  const search = extractQuotedValue(message)

  if (isOpenEntityRequest(message) && /\b(utent[ei]?|account|azienda|cliente)\b/.test(text)) {
    const target = extractEntityTarget(message) || extractUserTarget(message)
    const resolution = await resolveUser({target, token, services})

    if (resolution.status === 'resolved') {
      const id = resolution.item.id
      return {
        ok: true,
        intent: 'app-action',
        source: 'tool-fast',
        reply: `Apro ${resolution.item.company_name || resolution.item.name || 'l’utente selezionato'}.`,
        data: {
          type: 'app-action',
          appAction: {id: 'navigate', label: 'Apri utente', path: `/sendinitaly/users/${encodeURIComponent(String(id))}`},
          entity: {id, name: resolution.item.company_name || resolution.item.name, type: 'sendinitaly-user'},
        },
        meta: {moduleId: 'facile.sendinitaly'},
      }
    }

    if (resolution.status === 'ambiguous') {
      return {
        ok: true,
        intent: 'sendinitaly-user-open-ambiguous',
        source: 'tool-fast',
        reply: userClarification(resolution, target),
        data: {type: 'sendinitaly-users', data: resolution.items, meta: {total: resolution.items.length}, query: {search: target, intent: 'open'}},
        meta: {moduleId: 'facile.sendinitaly'},
      }
    }

    return {ok: true, intent: 'clarification', source: 'tool-fast', reply: userClarification(resolution, target), data: {type: 'clarification', reason: `sendinitaly-user-${resolution.status}`}, meta: {moduleId: 'facile.sendinitaly'}}
  }

  if (/\b(piani?|listino)\b/.test(text) && /send\s*in\s*italy|utent|account/.test(text) && !/campagn/.test(text)) {
    const payload = await services.getUserPlans({token})
    const items = Array.isArray(payload?.data) ? payload.data.map(item => ({id: item.id || item.name, name: item.name})).filter(item => item.name) : []
    return {
      ok: true,
      intent: 'sendinitaly-plans',
      source: 'tool-fast',
      reply: items.length ? [`Piani Send in Italy disponibili (${items.length}):`, ...items.map((item, index) => `${index + 1}. ${item.name}`)].join('\n') : 'Non risultano piani Send in Italy configurati.',
      data: {type: 'sendinitaly-plans', items, actions: [{id: 'navigate', label: 'Apri utenti', path: '/sendinitaly/users'}]},
      meta: {moduleId: 'facile.sendinitaly'},
    }
  }

  if (/\b(dns|spf|dkim|mittent[ei])\b/.test(text) && /\b(verifica|controlla|stato|problemi|configurazione)\b/.test(text)) {
    const target = extractUserTarget(message)
    const resolution = await resolveUser({target, token, services})
    if (resolution.status !== 'resolved') return {ok: true, intent: 'clarification', source: 'tool-fast', reply: userClarification(resolution, target), data: {type: 'clarification', reason: `sendinitaly-user-${resolution.status}`}, meta: {moduleId: 'facile.sendinitaly'}}
    const detailPayload = await services.getUser({token, userId: resolution.item.id})
    const user = sanitizeUserDetail(detailPayload?.data || {})
    if (!user.senderDomains.length) return {ok: true, intent: 'sendinitaly-dns-status', source: 'tool-fast', reply: `${user.companyName} non ha domini mittente da verificare.`, data: {type: 'sendinitaly-dns-status', user: {id: user.id, companyName: user.companyName}, items: [], actions: [{id: 'navigate', label: 'Apri utente', path: `/sendinitaly/users/${encodeURIComponent(String(user.id))}`}]}, meta: {moduleId: 'facile.sendinitaly'}}
    const checks = await Promise.all(user.senderDomains.map(async domain => {
      try {
        const payload = await services.getUserDnsStatus({token, userId: user.id, domain})
        const value = payload?.data || {}
        return {domain, status: value.status || (value.found ? 'configured' : 'zone_not_found'), found: value.found === true, checks: {spf: value.checks?.spf === true, click2: value.checks?.click2 === true, ss1rp: value.checks?.ss1rp === true}}
      } catch (error) {
        return {domain, status: 'error', found: false, checks: {spf: false, click2: false, ss1rp: false}, error: String(error?.message || 'verifica non riuscita').slice(0, 160)}
      }
    }))
    const healthy = checks.filter(item => item.status === 'configured' || Object.values(item.checks).every(Boolean)).length
    return {ok: true, intent: 'sendinitaly-dns-status', source: 'tool-fast', reply: `DNS mittenti di ${user.companyName}: ${healthy}/${checks.length} domini completi.`, data: {type: 'sendinitaly-dns-status', user: {id: user.id, companyName: user.companyName}, items: checks, actions: [{id: 'navigate', label: 'Apri utente', path: `/sendinitaly/users/${encodeURIComponent(String(user.id))}`}]}, meta: {moduleId: 'facile.sendinitaly'}}
  }

  if (/\b(dettaglio|scheda|situazione|stato)\b/.test(text) && /\b(utent[ei]?|account|azienda|cliente)\b/.test(text)) {
    const target = extractUserTarget(message)
    const resolution = await resolveUser({target, token, services})
    if (resolution.status !== 'resolved') return {ok: true, intent: 'clarification', source: 'tool-fast', reply: userClarification(resolution, target), data: {type: 'clarification', reason: `sendinitaly-user-${resolution.status}`}, meta: {moduleId: 'facile.sendinitaly'}}
    const payload = await services.getUser({token, userId: resolution.item.id})
    const user = sanitizeUserDetail(payload?.data || {})
    return {ok: true, intent: 'sendinitaly-user-detail', source: 'tool-fast', reply: formatUserDetail(user), data: {type: 'sendinitaly-user-detail', user, actions: [{id: 'navigate', label: 'Apri utente', path: `/sendinitaly/users/${encodeURIComponent(String(user.id))}`}]}, meta: {moduleId: 'facile.sendinitaly'}}
  }

  if (/statistic|performance|apert|click|consegn|bounce|invii/.test(text)) {
    const mode = parseMode(text)
    const payload = await services.getCampaignStats({token, mode})

    return {
      ok: true,
      intent: 'sendinitaly-stats',
      source: 'tool-fast',
      reply: formatStats(payload, mode),
      data: {
        type: 'sendinitaly-stats',
        mode,
        payload,
        actions: [{id: 'navigate', label: 'Apri statistiche', path: '/sendinitaly/statistics'}],
      },
      meta: {moduleId: 'facile.sendinitaly'},
    }
  }

  if (/utent|account|aziend|client|piano/.test(text) && !/campagn/.test(text)) {
    const payload = await services.getUsers({token, search})

    return {
      ok: true,
      intent: 'sendinitaly-users',
      source: 'tool-fast',
      reply: formatUsers(payload),
      data: {
        type: 'sendinitaly-users',
        query: {search},
        ...payload,
        actions: [{id: 'navigate', label: 'Apri utenti', path: '/sendinitaly/users'}],
      },
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
  const payload = await services.getCampaigns({token, search, status})

  return {
    ok: true,
    intent: 'sendinitaly-campaigns',
    source: 'tool-fast',
    reply: formatCampaigns(payload),
    data: {
      type: 'sendinitaly-campaigns',
      query: {search, status},
      ...payload,
      actions: [{id: 'navigate', label: 'Apri campagne', path: '/sendinitaly/campaigns'}],
    },
    meta: {moduleId: 'facile.sendinitaly'},
  }
}
