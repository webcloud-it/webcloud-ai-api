import {normalizeText} from '../../../utils/text.js'
import {
  extractEntityTarget,
  isOpenEntityRequest,
  resolveNamedEntity,
} from '../../../core/entities/entityResolver.js'
import {
  addSupportTicketArticle,
  createSupportTicket,
  escalateSupportTicket,
  getCampaigns,
  getCampaignStats,
  getSupportTickets,
  getSupportTicket,
  getUser,
  getUserDnsStatus,
  getUserPlans,
  getUsers,
  updateSupportTicket,
} from './service.js'
import {handleSupportChat} from './supportChat.js'

function extractQuotedValue(message = '') {
  return String(message).match(/["“”']([^"“”']{2,80})["“”']/)?.[1]?.trim() || ''
}

function parseMode(text = '') {
  if (/oggi|odiern/.test(text)) return 'today'
  if (/7 giorni|settimana/.test(text)) return 'last_7_days'
  if (/365 giorni|ultimo anno/.test(text)) return 'last_365_days'
  if (/anno corrente|quest.?anno/.test(text)) return 'current_year'
  if (/coda|queued|in attesa/.test(text)) return 'queued'
  if (/\bin corso\b|\bin invio\b|\bin_process\b/.test(text)) return 'in_process'
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

function extractUserPlanTarget(message = '') {
  return String(message)
    .match(/\b(?:piano|plan)\s+["“”']?([^"“”'?.!,;]{2,80})/i)?.[1]
    ?.replace(/\s+(?:e|ed|ma|con|senza)\s+.+$/i, '')
    .trim() || ''
}

const USER_RANKING_METRICS = [
  {pattern: /\bcampagn[ae]\b/i, sortBy: 'campaigns', field: 'total_campaigns', label: 'campagne'},
  {pattern: /\bcontatt[oi]\b/i, sortBy: 'contacts', field: 'total_contacts', label: 'contatti'},
  {pattern: /\blist[ae]\b/i, sortBy: 'lists', field: 'total_lists', label: 'liste'},
  {pattern: /\battribut[oi]\b/i, sortBy: 'attributes', field: 'total_attributes', label: 'attributi'},
  {pattern: /\bsegment[oi]\b/i, sortBy: 'segments', field: 'total_segments', label: 'segmenti'},
  {pattern: /\btemplate\b/i, sortBy: 'templates', field: 'total_templates', label: 'template'},
  {pattern: /\bform\b/i, sortBy: 'forms', field: 'total_forms', label: 'form'},
  {pattern: /\bautomazion[ei]\b/i, sortBy: 'automations', field: 'total_automations', label: 'automazioni'},
  {pattern: /\bmittent[ei]\b/i, sortBy: 'senders', field: 'total_senders', label: 'mittenti'},
]

function parseUserRanking(message = '') {
  const text = normalizeText(message)
  if (!/\b(?:utent[ei]?|account|client[ei]|aziend[ae])\b/i.test(text)) return null
  if (!/(?:pi[uù]|meno|maggior\w*|minor\w*|top|classific\w*|ranking|prim[ei])/i.test(text)) return null

  const metric = USER_RANKING_METRICS.find(item => item.pattern.test(text))
  if (!metric) return null

  const limitToken = text.match(/\b(?:prim[ei]|top)\s+(\d{1,2}|un[oa]?|due|tre|quattro|cinque|sei|sette|otto|nove|dieci)\b/i)?.[1]
  const numbers = new Map([
    ['uno', 1], ['un', 1], ['una', 1], ['due', 2], ['tre', 3], ['quattro', 4],
    ['cinque', 5], ['sei', 6], ['sette', 7], ['otto', 8], ['nove', 9], ['dieci', 10],
  ])
  const parsedLimit = /^\d+$/.test(limitToken || '')
    ? Number(limitToken)
    : numbers.get(limitToken || '')

  return {
    ...metric,
    sortOrder: /\b(?:meno|minor\w*)\b/i.test(text) ? 'asc' : 'desc',
    limit: Math.min(Math.max(parsedLimit || (/\bqual[ei]\b/i.test(text) ? 1 : 5), 1), 20),
  }
}

async function resolveUserPlan({target, token, services}) {
  const payload = await services.getUserPlans({token})
  const plans = Array.isArray(payload?.data) ? payload.data : []
  const needle = normalizeText(target)
  const matches = plans.filter(plan => {
    const values = [plan?.id, plan?.name].map(normalizeText).filter(Boolean)
    return values.some(value => value === needle || value.includes(needle) || needle.includes(value))
  })

  return matches.length === 1 ? matches[0] : null
}

function extractDnsUserTarget(message = '') {
  const quoted = extractQuotedValue(message)
  if (quoted) return quoted

  const text = String(message)
    .replace(/\b(?:su|di)\s+send\s*in\s*italy\b/gi, ' ')
    .replace(/\b(?:verifica|verificare|controlla|controllare|mostra|stato|situazione|problemi?|configurazione)\b/gi, ' ')
    .replace(/\b(?:dns|spf|dkim|domini?|mittent[ei])\b/gi, ' ')
    .replace(/\b(?:utent[ei]?|account|azienda|cliente)\b/gi, ' ')
    .replace(/\b(?:il|lo|la|i|gli|le|un|una|di|del|dello|della|dei|degli|delle)\b/gi, ' ')
    .replace(/[?.!,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return text
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

async function checkSenderDomainsForUser({userRef, token, services}) {
  const detailPayload = await services.getUser({token, userId: userRef.id})
  const user = sanitizeUserDetail(detailPayload?.data || {})
  const items = await Promise.all(user.senderDomains.map(async domain => {
    try {
      const payload = await services.getUserDnsStatus({token, userId: user.id, domain})
      const value = payload?.data || {}
      return {
        domain,
        status: value.status || (value.found ? 'configured' : 'zone_not_found'),
        found: value.found === true,
        checks: {
          spf: value.checks?.spf === true,
          click2: value.checks?.click2 === true,
          ss1rp: value.checks?.ss1rp === true,
        },
      }
    } catch (error) {
      return {
        domain,
        status: 'error',
        found: false,
        checks: {spf: false, click2: false, ss1rp: false},
        error: String(error?.message || 'verifica non riuscita').slice(0, 160),
      }
    }
  }))

  return {user, items}
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
    const plan = item.subscription_config?.plan?.name || item.plan?.name || item.plan_name || item.subscription_plan || null
    const contacts = item.total_contacts ?? item.contacts_count ?? null
    return `${index + 1}. ${item.company_name || item.name || item.id}${plan ? ` — piano ${plan}` : ''}${contacts !== null ? ` — ${contacts} contatti` : ''}`
  })

  return [`Ho trovato ${total} utenti Send in Italy.`, ...lines].join('\n')
}

function formatUserRanking(payload = {}, metric) {
  const items = Array.isArray(payload.data) ? payload.data : []
  if (!items.length) return `Non ho trovato utenti da classificare per ${metric.label}.`

  return [
    `Classifica utenti Send in Italy per ${metric.label}:`,
    ...items.map((item, index) =>
      `${index + 1}. ${item.company_name || item.name || item.id} — ${Number(item[metric.field] || 0)} ${metric.label}`
    ),
  ].join('\n')
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
  const totals = source?.totals && typeof source.totals === 'object' ? source.totals : source
  const received = Number(totals?.received || totals?.received_contacts || 0)
  const shipped = Number(totals?.shipped || totals?.shipped_contacts || 0)
  const opened = Number(totals?.opened || totals?.opened_contacts || 0)
  const clicked = Number(totals?.clicked || totals?.clicked_contacts || 0)
  const hardBounce = Number(totals?.hard_bounce || totals?.delivery_failed || 0)
  const rate = (value, base) => base > 0 ? `${((value / base) * 100).toFixed(1)}%` : 'n/d'
  const entries = collectScalarEntries(source).slice(0, 15)

  if (!entries.length) {
    return `Non risultano statistiche disponibili per il periodo ${mode}.`
  }

  return [
    `Statistiche Send in Italy (${mode}):`,
    `- tasso di apertura: ${rate(opened, received)}`,
    `- tasso di click: ${rate(clicked, received)}`,
    `- tasso hard bounce: ${rate(hardBounce, shipped)}`,
    ...entries.map(([key, value]) => `- ${key.replaceAll('_', ' ')}: ${value}`),
  ].join('\n')
}

export async function handleSendInItalyChat({
  message,
  token,
  context = {},
  history = [],
  services = {
    getCampaigns,
    getCampaignStats,
    getUsers,
    getUserPlans,
    getUser,
    getUserDnsStatus,
    getSupportTickets,
    getSupportTicket,
    createSupportTicket,
    addSupportTicketArticle,
    updateSupportTicket,
    escalateSupportTicket,
  },
} = {}) {
  const text = normalizeText(message)
  const search = extractQuotedValue(message)

  const supportResult = await handleSupportChat({message, token, context, history, services})
  if (supportResult) return supportResult

  const userPlanTarget = extractUserPlanTarget(message)
  if (
    userPlanTarget &&
    /\b(?:utent[ei]?|account|client[ei]|aziend[ae])\b/i.test(text) &&
    !/\b(?:dettaglio|scheda|apri|mostra\s+il)\b/i.test(text)
  ) {
    const resolvedPlan = await resolveUserPlan({target: userPlanTarget, token, services})
    const plan = resolvedPlan?.id || resolvedPlan?.name || userPlanTarget
    const payload = await services.getUsers({token, plan})
    return {
      ok: true,
      intent: 'sendinitaly-users',
      source: 'tool-fast',
      reply: formatUsers(payload),
      data: {type: 'sendinitaly-users', query: {plan}, ...payload},
      meta: {moduleId: 'facile.sendinitaly'},
    }
  }

  const userRanking = parseUserRanking(message)
  if (userRanking) {
    const payload = await services.getUsers({
      token,
      limit: userRanking.limit,
      sortBy: userRanking.sortBy,
      sortOrder: userRanking.sortOrder,
    })
    return {
      ok: true,
      intent: 'sendinitaly-user-ranking',
      source: 'tool-fast',
      reply: formatUserRanking(payload, userRanking),
      data: {
        type: 'sendinitaly-user-ranking',
        metric: userRanking.sortBy,
        direction: userRanking.sortOrder,
        items: Array.isArray(payload?.data) ? payload.data : [],
      },
      meta: {moduleId: 'facile.sendinitaly'},
    }
  }

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
    const target = extractDnsUserTarget(message)

    if (target) {
      const resolution = await resolveUser({target, token, services})
      if (resolution.status !== 'resolved') return {ok: true, intent: 'clarification', source: 'tool-fast', reply: userClarification(resolution, target), data: {type: 'clarification', reason: `sendinitaly-user-${resolution.status}`}, meta: {moduleId: 'facile.sendinitaly'}}
      const {user, items} = await checkSenderDomainsForUser({userRef: resolution.item, token, services})
      if (!items.length) return {ok: true, intent: 'sendinitaly-dns-status', source: 'tool-fast', reply: `${user.companyName} non ha domini mittente da verificare.`, data: {type: 'sendinitaly-dns-status', user: {id: user.id, companyName: user.companyName}, items: [], actions: [{id: 'navigate', label: 'Apri utente', path: `/sendinitaly/users/${encodeURIComponent(String(user.id))}`}]}, meta: {moduleId: 'facile.sendinitaly'}}
      const healthy = items.filter(item => item.status === 'configured' || Object.values(item.checks).every(Boolean)).length
      return {ok: true, intent: 'sendinitaly-dns-status', source: 'tool-fast', reply: `DNS mittenti di ${user.companyName}: ${healthy}/${items.length} domini completi.`, data: {type: 'sendinitaly-dns-status', user: {id: user.id, companyName: user.companyName}, items, actions: [{id: 'navigate', label: 'Apri utente', path: `/sendinitaly/users/${encodeURIComponent(String(user.id))}`}]}, meta: {moduleId: 'facile.sendinitaly'}}
    }

    const usersPayload = await services.getUsers({token, limit: 100})
    const users = Array.isArray(usersPayload?.data) ? usersPayload.data.filter(item => item?.id).slice(0, 100) : []
    const results = await Promise.all(users.map(async userRef => {
      try {
        return await checkSenderDomainsForUser({userRef, token, services})
      } catch {
        return {user: {id: userRef.id, companyName: userRef.company_name || userRef.name || String(userRef.id)}, items: []}
      }
    }))
    const items = results.flatMap(({user, items: userItems}) => userItems.map(item => ({...item, userId: user.id, companyName: user.companyName})))
    const healthy = items.filter(item => item.status === 'configured' || Object.values(item.checks).every(Boolean)).length
    const owners = new Set(items.map(item => item.userId)).size
    const reply = items.length
      ? `DNS mittenti complessivi: ${healthy}/${items.length} domini completi su ${owners} utenti.`
      : `Non risultano domini mittente configurati nei ${users.length} utenti Send in Italy analizzati.`
    return {ok: true, intent: 'sendinitaly-dns-status', source: 'tool-fast', reply, data: {type: 'sendinitaly-dns-status', scope: 'all-users', items, actions: [{id: 'navigate', label: 'Apri utenti', path: '/sendinitaly/users'}]}, meta: {moduleId: 'facile.sendinitaly'}}
  }

  if (
    /\b(dettaglio|scheda|situazione|stato)\b/.test(text) &&
    /\b(utent[ei]?|account|azienda|cliente)\b/.test(text) &&
    !/\b(ticket|assistenza|supporto)\b/.test(text)
  ) {
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
