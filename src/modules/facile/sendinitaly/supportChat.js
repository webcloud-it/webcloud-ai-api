import {createHash, randomUUID} from 'node:crypto'

import {resolveNamedEntity} from '../../../core/entities/entityResolver.js'
import {normalizeSearchText} from '../../../utils/text.js'

const proposals = new Map()
const PROPOSAL_TTL_MS = 10 * 60 * 1000
const SUPPORT_PATTERN = /\b(?:ticket|assistenza|supporto|help\s*desk|zammad)\b/i
const CONFIRM_PATTERN = /^\s*(?:confermo|conferma|procedi|esegui|s[iì])\s*[.!]?\s*$/i
const CANCEL_PATTERN = /^\s*(?:annulla|cancella|no)\s*[.!]?\s*$/i
const CATEGORY_ALIASES = new Map([
  ['account', 'account'],
  ['fatturazione', 'billing'],
  ['amministrazione', 'billing'],
  ['billing', 'billing'],
  ['campagna', 'campaigns'],
  ['campagne', 'campaigns'],
  ['contatti', 'contacts'],
  ['contatto', 'contacts'],
  ['deliverability', 'deliverability'],
  ['consegnabilita', 'deliverability'],
  ['recapito', 'deliverability'],
  ['form', 'forms'],
  ['moduli', 'forms'],
  ['integrazioni', 'integrations'],
  ['integrazione', 'integrations'],
  ['altro', 'other'],
])

function response(intent, reply, data, source = 'tool-fast') {
  return {
    ok: true,
    intent,
    source,
    reply,
    data,
    meta: {moduleId: 'facile.sendinitaly', intent, source},
  }
}

function scalar(value) {
  if (value == null) return null
  if (typeof value === 'object') return value.name || value.label || value.id || null
  return String(value)
}

function toTime(value) {
  const time = Date.parse(value || '')
  return Number.isFinite(time) ? time : null
}

function sanitizeTicket(ticket = {}) {
  return {
    id: ticket.id || null,
    number: ticket.number || null,
    title: ticket.title || 'Ticket senza titolo',
    state: scalar(ticket.state),
    priority: scalar(ticket.priority),
    category: scalar(ticket.category),
    customerId: ticket.customer_id || null,
    customerName: ticket.customer?.company_name || ticket.customer?.email || null,
    crmCustomerId: ticket.crm_customer_id || null,
    owner: scalar(ticket.owner),
    clickupLinked: Boolean(ticket.clickup_task_id),
    articleCount: Number(ticket.article_count || 0),
    createdAt: ticket.created_at || null,
    updatedAt: ticket.updated_at || null,
    lastContactAt: ticket.last_contact_at || null,
    lastAgentAt: ticket.last_contact_agent_at || null,
    lastCustomerAt: ticket.last_contact_customer_at || null,
    csatScore: Number(ticket.csat_score || 0) || null,
  }
}

function ticketLabel(ticket = {}) {
  return `#${ticket.number || ticket.id} ${ticket.title || 'Ticket'}`
}

function normalizeComparable(value = '') {
  return normalizeSearchText(String(value || '')).replace(/^\d+\s+/, '').trim()
}

function parseState(text = '') {
  if (/\b(?:chius|risolt|complet)/.test(text)) return 'closed'
  if (/\b(?:in attesa|pending)/.test(text)) return 'pending'
  if (/\bnuov/.test(text)) return 'new'
  if (/\b(?:apert|attiv|da gestire)/.test(text)) return 'active'
  return ''
}

function parsePriority(text = '') {
  if (/\b(?:alta|alto|high|urgent|urgente|critica|critico)\b/.test(text)) return 'high'
  if (/\b(?:bassa|basso|low)\b/.test(text)) return 'low'
  if (/\b(?:normale|normal|media|medio)\b/.test(text)) return 'normal'
  return ''
}

function parseCategory(text = '') {
  for (const [alias, category] of CATEGORY_ALIASES) {
    if (new RegExp(`\\b${alias}\\b`, 'i').test(text)) return category
  }
  return ''
}

function parsePeriod(text = '', now = Date.now()) {
  if (/\boggi\b/.test(text)) {
    const date = new Date(now)
    date.setHours(0, 0, 0, 0)
    return {since: date.getTime(), label: 'oggi'}
  }

  const match = text.match(/(?:ultim[oi]|scors[oi]|negli?\s+ultimi?)\s+(\d+)\s+(giorn|settiman|mes|ann)/)
  if (match) {
    const amount = Math.max(1, Math.min(Number(match[1]), 60))
    const unit = match[2]
    const days = unit.startsWith('giorn')
      ? amount
      : unit.startsWith('settiman')
        ? amount * 7
        : unit.startsWith('mes')
          ? amount * 30
          : amount * 365
    return {since: now - days * 864e5, label: `${amount} ${unit}`}
  }

  if (/\b(?:ultimo|scorso)\s+mese\b/.test(text)) return {since: now - 30 * 864e5, label: 'ultimo mese'}
  if (/\b(?:ultima|scorsa)\s+settimana\b/.test(text)) return {since: now - 7 * 864e5, label: 'ultima settimana'}
  if (/\b(?:ultimo|scorso)\s+anno\b/.test(text)) return {since: now - 365 * 864e5, label: 'ultimo anno'}
  return null
}

function parseAgeThreshold(text = '') {
  const match = text.match(/(?:piu|oltre|da)\s+(?:piu\s+)?(?:di\s+)?(\d+)\s*(or[ae]|giorn[oi]|settiman[ae])/)
  if (!match) return null
  const amount = Math.max(1, Number(match[1]))
  const hours = match[2].startsWith('or') ? amount : match[2].startsWith('giorn') ? amount * 24 : amount * 168
  return {ms: hours * 36e5, label: `${amount} ${match[2]}`}
}

function extractQuoted(message = '') {
  return [...String(message).matchAll(/["“”']([^"“”']{2,160})["“”']/g)].map(match => match[1].trim())
}

function extractTicketReference(message = '') {
  return String(message).match(/#\s*(\d{1,20})\b/)?.[1] ||
    String(message).match(/\bticket\s+(?:numero\s+|n[.°]\s*)?(\d{1,20})\b/i)?.[1] ||
    null
}

function findPriorSupportData(history = []) {
  return [...history].reverse().map(item => item?.data).find(data =>
    ['sendinitaly-support-tickets', 'sendinitaly-support-ticket-detail', 'sendinitaly-support-analysis'].includes(data?.type)
  ) || null
}

function ordinalIndex(message = '') {
  const text = normalizeSearchText(message)
  if (/\b(?:prim[oa]|1)\b/.test(text)) return 0
  if (/\b(?:second[oa]|2)\b/.test(text)) return 1
  if (/\b(?:terz[oa]|3)\b/.test(text)) return 2
  return null
}

function findProposalToken(history = []) {
  return [...history].reverse().find(item =>
    item?.data?.type === 'action-proposal' && String(item?.data?.operation || '').startsWith('support-')
  )?.data?.proposalToken || null
}

function fingerprint(token = '') {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 16)
}

function audit(event, proposal, extra = {}) {
  console.info('[support-action-audit]', JSON.stringify({
    at: new Date().toISOString(),
    event,
    actor: proposal?.actorFingerprint || null,
    operation: proposal?.operation || null,
    ticketId: proposal?.ticketId || null,
    customerId: proposal?.customerId || null,
    ...extra,
  }))
}

async function resolveCustomer({target, token, services}) {
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
  if (resolution.status === 'ambiguous') return {status: 'ambiguous', items: resolution.candidates.map(item => item.item)}
  return {status: 'not-found', items: []}
}

function extractCustomerTarget(message = '') {
  const quoted = extractQuoted(message)[0]
  if (quoted && /\b(?:cliente|azienda|utente|account)\b/i.test(message)) return quoted
  const match = String(message).match(/\b(?:cliente|azienda|utente|account)\s+(.+?)(?=\s+(?:con|che|ha|nei?|nelle?|degli?|delle?|e\s+(?:ticket|assistenza)|apert|chius|pending|nuov|nell|ultim|piu|più)\b|[?.!,;:]|$)/i)
  return match?.[1]?.trim() || ''
}

function customerClarification(resolution, target) {
  if (resolution.status === 'ambiguous') {
    const options = resolution.items.slice(0, 8).map((item, index) => `${index + 1}. ${item.company_name || item.name || item.id}`)
    return `Ho trovato più clienti corrispondenti a “${target}”:\n${options.join('\n')}\nIndicami quello esatto.`
  }
  return `Non ho trovato un cliente Send in Italy corrispondente a “${target}”.`
}

async function loadAllTickets({token, services, customerId = '', state = '', search = '', max = 500}) {
  const items = []
  let page = 1
  let total = Infinity
  while (items.length < total && items.length < max) {
    const payload = await services.getSupportTickets({token, customerId, state, search, page, perPage: 50})
    const batch = Array.isArray(payload?.data) ? payload.data : []
    items.push(...batch)
    total = Number(payload?.meta?.total ?? items.length)
    if (!batch.length || batch.length < 50) break
    page += 1
  }
  return {items: items.slice(0, max).map(sanitizeTicket), total, truncated: total > max}
}

async function resolveTicket({message, token, history, services}) {
  const prior = findPriorSupportData(history)
  const reference = extractTicketReference(message)
  const priorItems = prior?.ticket ? [prior.ticket] : Array.isArray(prior?.items) ? prior.items : []

  if (reference) {
    const match = priorItems.find(item => [item.id, item.number].some(value => String(value) === reference))
    if (match) return {status: 'resolved', item: match}
    const payload = await services.getSupportTickets({token, search: reference, perPage: 50})
    const matches = (Array.isArray(payload?.data) ? payload.data : [])
      .map(sanitizeTicket)
      .filter(item => [item.id, item.number].some(value => String(value) === reference))
    if (matches.length === 1) return {status: 'resolved', item: matches[0]}
    try {
      const detail = await services.getSupportTicket({token, ticketId: reference})
      if (detail?.data?.ticket) return {status: 'resolved', item: sanitizeTicket(detail.data.ticket), detail: detail.data}
    } catch (_) {
      // Il riferimento potrebbe essere il numero pubblico e non l'id Zammad.
    }
    return {status: matches.length > 1 ? 'ambiguous' : 'not-found', items: matches}
  }

  const index = ordinalIndex(message)
  if (index !== null && priorItems[index]) return {status: 'resolved', item: priorItems[index]}
  if (prior?.ticket) return {status: 'resolved', item: prior.ticket}
  if (priorItems.length === 1) return {status: 'resolved', item: priorItems[0]}
  return {status: 'missing', items: priorItems}
}

function ticketClarification(resolution) {
  if (resolution.status === 'not-found') return 'Non ho trovato quel ticket. Indicami il numero mostrato in assistenza.'
  if (resolution.items?.length) {
    return `A quale ticket ti riferisci? ${resolution.items.slice(0, 8).map(ticketLabel).join(', ')}.`
  }
  return 'Quale ticket vuoi gestire? Indicami il numero, per esempio “ticket #12345”.'
}

function proposalResponse(proposal) {
  const token = randomUUID()
  proposals.set(token, proposal)
  audit('proposed', proposal)
  const action = proposal.operation === 'support-reply'
    ? `inviare una risposta pubblica a ${ticketLabel(proposal.ticket)}`
    : proposal.operation === 'support-note'
      ? `aggiungere una nota interna a ${ticketLabel(proposal.ticket)}`
      : proposal.operation === 'support-escalate'
        ? `creare o collegare l’escalation ClickUp per ${ticketLabel(proposal.ticket)}`
        : proposal.operation === 'support-create'
          ? `creare un ticket per ${proposal.customerName}`
          : `aggiornare ${ticketLabel(proposal.ticket)}`
  return response(
    'support-action-preview',
    `Sto per ${action}. Scrivi “confermo” per procedere oppure “annulla”.`,
    {
      type: 'action-proposal',
      operation: proposal.operation,
      proposalToken: token,
      expiresAt: new Date(proposal.expiresAt).toISOString(),
      target: proposal.ticket
        ? {id: proposal.ticket.id, name: ticketLabel(proposal.ticket)}
        : {id: proposal.customerId, name: proposal.customerName},
      changes: proposal.changes || [],
      confirmationRequired: true,
    }
  )
}

async function handleProposalDecision({message, token, history, services}) {
  const proposalToken = findProposalToken(history)
  if (!proposalToken || (!CONFIRM_PATTERN.test(message) && !CANCEL_PATTERN.test(message))) return null
  const proposal = proposals.get(proposalToken)
  if (!proposal || proposal.expiresAt < Date.now()) {
    proposals.delete(proposalToken)
    return response('action-expired', 'La proposta è scaduta. Chiedimi di prepararla nuovamente.', {type: 'action-expired'})
  }
  if (proposal.actorFingerprint !== fingerprint(token)) {
    audit('rejected-actor', proposal)
    return response('action-error', 'Questa proposta appartiene a un’altra sessione.', {type: 'action-error', operation: proposal.operation})
  }
  if (CANCEL_PATTERN.test(message)) {
    proposals.delete(proposalToken)
    audit('cancelled', proposal)
    return response('action-cancelled', 'Operazione annullata: non ho modificato il ticket.', {type: 'action-cancelled', operation: proposal.operation})
  }

  let result
  audit('confirmed', proposal)
  try {
    if (proposal.operation === 'support-reply' || proposal.operation === 'support-note') {
      result = await services.addSupportTicketArticle({
        token,
        ticketId: proposal.ticketId,
        body: proposal.body,
        internal: proposal.operation === 'support-note',
      })
    } else if (proposal.operation === 'support-escalate') {
      result = await services.escalateSupportTicket({token, ticketId: proposal.ticketId})
    } else if (proposal.operation === 'support-update') {
      result = await services.updateSupportTicket({
        token,
        ticketId: proposal.ticketId,
        state: proposal.state,
        priority: proposal.priority,
      })
    } else if (proposal.operation === 'support-create') {
      result = await services.createSupportTicket({
        token,
        customerId: proposal.customerId,
        category: proposal.category,
        title: proposal.title,
        description: proposal.description,
      })
    }
    audit('completed', proposal)
  } catch (error) {
    audit('failed', proposal, {errorName: error?.name || 'Error'})
    throw error
  } finally {
    proposals.delete(proposalToken)
  }

  const completed = proposal.operation === 'support-reply'
    ? 'Risposta inviata al cliente.'
    : proposal.operation === 'support-note'
      ? 'Nota interna aggiunta al ticket.'
      : proposal.operation === 'support-escalate'
        ? 'Escalation tecnica completata.'
        : proposal.operation === 'support-create'
          ? `Ticket creato per ${proposal.customerName}.`
          : 'Ticket aggiornato e verificato dal servizio assistenza.'
  return response('support-action-result', completed, {
    type: 'action-result',
    operation: proposal.operation,
    target: proposal.ticket ? {id: proposal.ticketId, name: ticketLabel(proposal.ticket)} : {id: proposal.customerId, name: proposal.customerName},
    result: result?.data || result || null,
  })
}

function parseMessageBody(message = '') {
  const quoted = extractQuoted(message)
  if (quoted.length) return quoted.at(-1)
  return String(message).split(/:\s*/).slice(1).join(': ').trim()
}

async function handleMutationRequest({message, text, token, context, history, services}) {
  const creates = /\b(?:crea|apri|inserisci)\s+(?:un\s+)?(?:nuov[oa]\s+)?ticket\b/.test(text)
  if (creates) {
    const customerTarget = extractCustomerTarget(message)
    if (!customerTarget) return response('clarification', 'Per quale cliente Send in Italy devo preparare il nuovo ticket?', {type: 'clarification', reason: 'support-customer-required'})
    const customer = await resolveCustomer({target: customerTarget, token, services})
    if (customer.status !== 'resolved') return response('clarification', customerClarification(customer, customerTarget), {type: 'clarification', reason: `support-customer-${customer.status}`})
    const body = parseMessageBody(message)
    const parts = body.split(/\s+(?:\||—|-)\s+/).map(value => value.trim()).filter(Boolean)
    if (parts.length < 2 || parts[0].length < 5 || parts.slice(1).join(' - ').length < 10) {
      return response('clarification', 'Indicami titolo e descrizione separati da “ - ”, per esempio: crea ticket per Acme: Dominio non verificato - Il dominio mittente non supera il controllo SPF.', {type: 'clarification', reason: 'support-ticket-content-required'})
    }
    const proposal = {
      operation: 'support-create', customerId: customer.item.id,
      customerName: customer.item.company_name || customer.item.name || customer.item.id,
      category: parseCategory(text) || 'other', title: parts[0].slice(0, 160),
      description: parts.slice(1).join(' - ').slice(0, 10000), actorFingerprint: fingerprint(token),
      expiresAt: Date.now() + PROPOSAL_TTL_MS,
      changes: [{label: 'Categoria', from: '—', to: parseCategory(text) || 'other'}],
    }
    return proposalResponse(proposal)
  }

  const action = /\b(?:rispondi|nota\s+interna|annota|escala|chiudi|riapri|metti\s+in\s+attesa)\b/.test(text) || /\b(?:imposta|cambia|assegna)\b[\s\S]*\bpriorita\b/.test(text) || /\b(?:crea|avvia|collega)\b[\s\S]*\b(?:escalation|clickup)\b/.test(text)
  if (!action) return null
  const resolved = await resolveTicket({message, token, history, services})
  if (resolved.status !== 'resolved') return response('clarification', ticketClarification(resolved), {type: 'clarification', reason: `support-ticket-${resolved.status}`})
  const ticket = resolved.item
  const base = {ticket, ticketId: ticket.id, actorFingerprint: fingerprint(token), expiresAt: Date.now() + PROPOSAL_TTL_MS}

  if (/\brispondi\b/.test(text)) {
    const body = parseMessageBody(message)
    if (!body) return response('clarification', `Quale risposta vuoi inviare a ${ticketLabel(ticket)}? Scrivila dopo i due punti.`, {type: 'clarification', reason: 'support-reply-body-required'})
    return proposalResponse({...base, operation: 'support-reply', body})
  }
  if (/\b(?:nota\s+interna|annota)\b/.test(text)) {
    const body = parseMessageBody(message)
    if (!body) return response('clarification', `Quale nota interna vuoi aggiungere a ${ticketLabel(ticket)}?`, {type: 'clarification', reason: 'support-note-body-required'})
    return proposalResponse({...base, operation: 'support-note', body})
  }
  if (/\b(?:escalation|escala|clickup)\b/.test(text)) return proposalResponse({...base, operation: 'support-escalate'})

  const state = /\bchiudi\b/.test(text) ? 'closed' : /\briapri\b/.test(text) ? 'open' : /\bmetti\s+in\s+attesa\b/.test(text) ? 'pending' : ''
  const priority = parsePriority(text)
  if (!state && !priority) return null
  const changes = [
    state ? {label: 'Stato', from: ticket.state || '—', to: state} : null,
    priority ? {label: 'Priorità', from: ticket.priority || '—', to: priority} : null,
  ].filter(Boolean)
  return proposalResponse({...base, operation: 'support-update', state, priority, changes})
}

function sanitizeArticle(article = {}) {
  return {
    id: article.id || null,
    body: String(article.body || '').trim().slice(0, 3000),
    sender: scalar(article.sender),
    from: article.from || null,
    internal: article.internal === true,
    createdAt: article.created_at || null,
    attachments: Array.isArray(article.attachments)
      ? article.attachments.slice(0, 10).map(item => ({filename: item.filename || 'allegato', size: Number(item.size || 0)}))
      : [],
  }
}

async function handleDetailRequest({message, text, token, history, services}) {
  const asksDetail = /\b(?:dettagl(?:io|i)|conversazione|cronologia|messaggi?|risposte?|ultima\s+risposta|cosa\s+(?:dice|chiede))\b/.test(text)
  if (!asksDetail) return null
  const resolved = await resolveTicket({message, token, history, services})
  if (resolved.status !== 'resolved') return response('clarification', ticketClarification(resolved), {type: 'clarification', reason: `support-ticket-${resolved.status}`})
  const payload = resolved.detail || (await services.getSupportTicket({token, ticketId: resolved.item.id}))?.data || {}
  const ticket = sanitizeTicket(payload.ticket || resolved.item)
  const articles = (Array.isArray(payload.articles) ? payload.articles : []).map(sanitizeArticle)
  const visible = /\bultima\s+risposta\b/.test(text) ? articles.slice(-1) : articles.slice(-10)
  const lines = [
    `${ticketLabel(ticket)} — ${ticket.state || 'stato non disponibile'}, priorità ${ticket.priority || 'non disponibile'}.`,
    `Cliente: ${ticket.customerName || ticket.customerId || 'non associato'}; categoria: ${ticket.category || 'non indicata'}; messaggi: ${articles.length}.`,
    ...visible.map(article => `- ${article.createdAt ? String(article.createdAt).slice(0, 16).replace('T', ' ') : 'data non disponibile'} · ${article.internal ? 'nota interna' : article.sender || 'messaggio'}: ${article.body || '(solo allegati)'}`),
  ]
  return response('sendinitaly-support-ticket-detail', lines.join('\n'), {
    type: 'sendinitaly-support-ticket-detail', ticket, articles: visible,
    actions: [{id: 'navigate', label: 'Apri ticket', path: '/sendinitaly/support', query: {ticket_id: String(ticket.id)}}],
  }, 'tool-semantic')
}

function applyReadFilters(items, {state, priority, category, period, age, unanswered, escalated, text, now}) {
  return items.filter(ticket => {
    const ticketState = normalizeComparable(ticket.state)
    if (state === 'active' && ticketState === 'closed') return false
    if (state && state !== 'active' && ticketState !== state) return false
    if (priority && normalizeComparable(ticket.priority) !== priority) return false
    if (category && normalizeComparable(ticket.category) !== category) return false
    if (period && (toTime(ticket.updatedAt) || toTime(ticket.createdAt) || 0) < period.since) return false
    if (/\bsenza\s+(?:escalation|clickup)\b/.test(text) && ticket.clickupLinked) return false
    if (escalated && !ticket.clickupLinked) return false
    if (unanswered) {
      const customer = toTime(ticket.lastCustomerAt)
      const agent = toTime(ticket.lastAgentAt)
      if (!customer || (agent && agent >= customer)) return false
      if (age && now - customer < age.ms) return false
    } else if (age) {
      const reference = toTime(ticket.updatedAt) || toTime(ticket.createdAt)
      if (!reference || now - reference < age.ms) return false
    }
    return true
  })
}

function groupField(text = '') {
  if (
    /\b(?:per\s+cliente|quali\s+clienti|clienti\s+con\s+(?:piu|più|meno))\b/.test(text) ||
    /\b(?:confront\w*|prim[ei]\s+(?:due|2))\b[\s\S]*\bclienti\b/.test(text)
  ) return ['customerName', 'cliente']
  if (/\b(?:per\s+categoria|categorie\s+con|distribuzione\s+.*categoria)\b/.test(text)) return ['category', 'categoria']
  if (/\b(?:per\s+stato|stati\s+con|distribuzione\s+.*stato)\b/.test(text)) return ['state', 'stato']
  if (/\b(?:per\s+priorita|priorita\s+con|distribuzione\s+.*priorita)\b/.test(text)) return ['priority', 'priorità']
  if (/\b(?:per\s+operatore|per\s+assegnatario|operatori\s+con)\b/.test(text)) return ['owner', 'operatore']
  return null
}

function analyticalReply({items, allCount, truncated, field, operation, filtersLabel, compareTopTwo = false}) {
  if (field) {
    const groups = new Map()
    for (const ticket of items) {
      const label = ticket[field[0]] || 'non indicato'
      groups.set(label, (groups.get(label) || 0) + 1)
    }
    const ranking = [...groups.entries()].map(([label, count]) => ({label, count})).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    const lines = ranking.slice(0, 20).map((item, index) => `${index + 1}. ${item.label}: ${item.count} ticket`)
    const comparison = compareTopTwo && ranking.length >= 2
      ? `\nConfronto: ${ranking[0].label} ha ${ranking[0].count} ticket, ${ranking[1].label} ne ha ${ranking[1].count}; differenza ${ranking[0].count - ranking[1].count}.`
      : ''
    return {
      reply: lines.length ? `Distribuzione per ${field[1]}${filtersLabel}:\n${lines.join('\n')}${comparison}${truncated ? '\nAnalisi limitata ai primi 500 ticket.' : ''}` : `Non risultano ticket${filtersLabel}.`,
      analysis: {operation: compareTopTwo ? 'compare' : 'groupBy', dimension: field[0], ranking, comparison: compareTopTwo && ranking.length >= 2 ? {first: ranking[0], second: ranking[1], difference: ranking[0].count - ranking[1].count} : null},
    }
  }
  if (operation === 'count') {
    return {reply: `Risultano ${items.length} ticket${filtersLabel}.`, analysis: {operation: 'count', count: items.length}}
  }
  return {reply: '', analysis: {operation: 'list', count: items.length, totalLoaded: allCount}}
}

function formatTicketList(items, total, filtersLabel = '') {
  if (!items.length) return `Non risultano ticket${filtersLabel}.`
  const lines = items.slice(0, 20).map((ticket, index) => {
    const customer = ticket.customerName ? ` — ${ticket.customerName}` : ''
    const state = ticket.state ? ` [${ticket.state}]` : ''
    const priority = ticket.priority ? ` — priorità ${ticket.priority}` : ''
    const escalation = ticket.clickupLinked ? ' — ClickUp' : ''
    return `${index + 1}. ${ticketLabel(ticket)}${customer}${state}${priority}${escalation}`
  })
  return [`Ho trovato ${total} ticket${filtersLabel}.`, ...lines].join('\n')
}

async function handleReadRequest({message, text, token, context, services, now = Date.now()}) {
  const state = parseState(text)
  const priority = parsePriority(text)
  const category = parseCategory(text)
  const period = parsePeriod(text, now)
  const age = parseAgeThreshold(text)
  const unanswered = /\b(?:senza\s+risposta|da\s+rispondere|attendono\s+risposta|cliente\s+in\s+attesa)\b/.test(text)
  const escalated = /\b(?:escalat|clickup|sviluppo)\b/.test(text) && !/\bsenza\b/.test(text)
  const customerTarget = extractCustomerTarget(message)
  const hasModuleContext = Boolean(context?.activeModuleId || context?.section)
  const isSendContext = !hasModuleContext || context?.activeModuleId === 'facile.sendinitaly' || String(context?.section || '').startsWith('sendinitaly')
  let customerId = isSendContext ? context?.scope?.customerId || context?.customerId || '' : ''
  let customerName = ''
  if (!customerId && customerTarget) {
    const resolution = await resolveCustomer({target: customerTarget, token, services})
    if (resolution.status !== 'resolved') return response('clarification', customerClarification(resolution, customerTarget), {type: 'clarification', reason: `support-customer-${resolution.status}`})
    customerId = resolution.item.id
    customerName = resolution.item.company_name || resolution.item.name || ''
  }
  const search = !customerId ? extractQuoted(message)[0] || '' : ''
  const loaded = await loadAllTickets({
    token,
    services,
    customerId,
    state: state === 'active' ? '' : state,
    search,
  })
  let items = applyReadFilters(loaded.items, {state, priority, category, period, age, unanswered, escalated, text, now})
  if (/\b(?:piu|più)\s+vecch|da\s+piu\s+tempo/.test(text)) {
    items = items.sort((a, b) => (toTime(a.createdAt) || Infinity) - (toTime(b.createdAt) || Infinity))
  } else {
    items = items.sort((a, b) => (toTime(b.updatedAt) || 0) - (toTime(a.updatedAt) || 0))
  }
  const labels = [
    state ? (state === 'active' ? 'non chiusi' : `stato ${state}`) : '', priority ? `priorità ${priority}` : '', category ? `categoria ${category}` : '',
    period?.label || '', age ? `da oltre ${age.label}` : '', unanswered ? 'senza risposta operatore' : '',
    escalated ? 'con escalation ClickUp' : '', customerName ? `del cliente ${customerName}` : '',
  ].filter(Boolean)
  const filtersLabel = labels.length ? ` (${labels.join(', ')})` : ''
  const field = groupField(text)
  const operation = /\b(?:quanti|quante|conta|conteggio|numero\s+di)\b/.test(text) ? 'count' : field ? 'aggregate' : 'list'
  const compareTopTwo = Boolean(field && /\b(?:confront\w*|prim[ei]\s+(?:due|2))\b/.test(text))
  const analytical = analyticalReply({items, allCount: loaded.items.length, truncated: loaded.truncated, field, operation, filtersLabel, compareTopTwo})
  const reply = analytical.reply || formatTicketList(items, items.length, filtersLabel)
  return response(
    field || operation === 'count' || unanswered || age ? 'sendinitaly-support-analysis' : 'sendinitaly-support-tickets',
    reply,
    {
      type: field || operation === 'count' || unanswered || age ? 'sendinitaly-support-analysis' : 'sendinitaly-support-tickets',
      items: items.slice(0, 50), total: items.length, loadedTotal: loaded.items.length,
      filters: {customerId: customerId || null, state: state || null, priority: priority || null, category: category || null, period: period?.label || null, unanswered, escalated},
      analysis: analytical.analysis,
      actions: [{id: 'navigate', label: 'Apri assistenza', path: '/sendinitaly/support', query: customerId ? {customer_id: String(customerId)} : {}}],
    },
    field || operation === 'count' || unanswered || age ? 'tool-semantic' : 'tool-fast'
  )
}

export function isSupportChatRequest({message = '', history = []} = {}) {
  return SUPPORT_PATTERN.test(message) || Boolean(findProposalToken(history)) || Boolean(findPriorSupportData(history) && /\b(?:quest[oi]|prim[oa]|second[oa]|terz[oa]|aprilo|chiudilo|rispondi|escalalo)\b/i.test(message))
}

export async function handleSupportChat({message = '', token, context = {}, history = [], services} = {}) {
  if (!isSupportChatRequest({message, history})) return null
  const decision = await handleProposalDecision({message, token, history, services})
  if (decision) return decision
  const text = normalizeSearchText(message)
  const mutation = await handleMutationRequest({message, text, token, context, history, services})
  if (mutation) return mutation
  const detail = await handleDetailRequest({message, text, token, history, services})
  if (detail) return detail
  return handleReadRequest({message, text, token, context, services})
}
