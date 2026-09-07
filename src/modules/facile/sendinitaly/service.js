import {env} from '../../../config/env.js'
import {fetchJson, joinUrl} from '../../../utils/http.js'

const DEFAULT_TIMEOUT_MS = 20000

function requireConfiguration(baseUrl = env.sendInItalyApiBaseUrl, variable = 'SENDINITALY_API_BASE_URL') {
  if (!baseUrl) {
    const error = new Error(`${variable} non configurato`)
    error.statusCode = 503
    throw error
  }
}

function requireToken(token) {
  if (!token) {
    const error = new Error('Credenziale Send in Italy mancante')
    error.statusCode = 401
    throw error
  }
}

function headers(token) {
  return {'api-key': token, Accept: 'application/json'}
}

function jsonHeaders(token) {
  return {...headers(token), 'Content-Type': 'application/json'}
}

function withQuery(path, values = {}) {
  const query = new URLSearchParams()

  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === '') continue
    query.set(key, String(value))
  }

  const suffix = query.toString()
  return suffix ? `${path}?${suffix}` : path
}

export async function getCampaigns({token, page = 1, limit = 20, search = '', status = ''} = {}) {
  requireConfiguration()
  requireToken(token)

  return fetchJson(
    joinUrl(
      env.sendInItalyApiBaseUrl,
      withQuery('/facile/campaigns', {page, limit, search, status})
    ),
    {headers: headers(token), timeoutMs: DEFAULT_TIMEOUT_MS},
    'Errore recupero campagne Send in Italy'
  )
}

export async function getCampaignStats({token, mode = 'last_30_days'} = {}) {
  requireConfiguration()
  requireToken(token)

  return fetchJson(
    joinUrl(env.sendInItalyApiBaseUrl, withQuery('/facile/campaigns/stats', {mode})),
    {headers: headers(token), timeoutMs: DEFAULT_TIMEOUT_MS},
    'Errore recupero statistiche Send in Italy'
  )
}

export async function getUsers({token, page = 1, limit = 20, search = '', plan = ''} = {}) {
  requireConfiguration()
  requireToken(token)

  return fetchJson(
    joinUrl(
      env.sendInItalyApiBaseUrl,
      withQuery('/facile/users', {page, limit, search, plan})
    ),
    {headers: headers(token), timeoutMs: DEFAULT_TIMEOUT_MS},
    'Errore recupero utenti Send in Italy'
  )
}

export async function getUserPlans({token} = {}) {
  requireConfiguration()
  requireToken(token)
  return fetchJson(
    joinUrl(env.sendInItalyApiBaseUrl, '/facile/users/plans'),
    {headers: headers(token), timeoutMs: DEFAULT_TIMEOUT_MS},
    'Errore recupero piani Send in Italy'
  )
}

export async function getUser({token, userId} = {}) {
  requireConfiguration()
  requireToken(token)
  if (!userId) {
    const error = new Error('Utente Send in Italy mancante')
    error.statusCode = 400
    throw error
  }
  return fetchJson(
    joinUrl(env.sendInItalyApiBaseUrl, `/facile/users/${encodeURIComponent(String(userId))}`),
    {headers: headers(token), timeoutMs: DEFAULT_TIMEOUT_MS},
    'Errore recupero dettaglio utente Send in Italy'
  )
}

export async function getUserDnsStatus({token, userId, domain} = {}) {
  requireConfiguration()
  requireToken(token)
  if (!userId || !domain) {
    const error = new Error('Utente e dominio obbligatori per la verifica DNS')
    error.statusCode = 400
    throw error
  }
  return fetchJson(
    joinUrl(env.sendInItalyApiBaseUrl, withQuery(`/facile/users/${encodeURIComponent(String(userId))}/cloudflare-dns-status`, {domain})),
    {headers: headers(token), timeoutMs: DEFAULT_TIMEOUT_MS},
    'Errore verifica DNS Send in Italy'
  )
}

export async function getSupportTickets({
  token,
  page = 1,
  perPage = 25,
  customerId = '',
  state = '',
  search = '',
} = {}) {
  requireConfiguration(env.sendInItalySupportApiBaseUrl, 'SENDINITALY_SUPPORT_API_BASE_URL')
  requireToken(token)

  return fetchJson(
    joinUrl(
      env.sendInItalySupportApiBaseUrl,
      withQuery('/facile/support/tickets', {
        page,
        per_page: perPage,
        customer_id: customerId,
        state,
        search,
      })
    ),
    {headers: headers(token), timeoutMs: DEFAULT_TIMEOUT_MS},
    'Errore recupero ticket assistenza Send in Italy'
  )
}

export async function getSupportTicket({token, ticketId} = {}) {
  requireConfiguration(env.sendInItalySupportApiBaseUrl, 'SENDINITALY_SUPPORT_API_BASE_URL')
  requireToken(token)
  if (!ticketId) {
    const error = new Error('Ticket assistenza mancante')
    error.statusCode = 400
    throw error
  }

  return fetchJson(
    joinUrl(
      env.sendInItalySupportApiBaseUrl,
      `/facile/support/tickets/${encodeURIComponent(String(ticketId))}`
    ),
    {headers: headers(token), timeoutMs: DEFAULT_TIMEOUT_MS},
    'Errore recupero dettaglio ticket assistenza Send in Italy'
  )
}

async function supportMutation({token, path, method = 'POST', body, errorMessage}) {
  requireConfiguration(env.sendInItalySupportApiBaseUrl, 'SENDINITALY_SUPPORT_API_BASE_URL')
  requireToken(token)

  return fetchJson(
    joinUrl(env.sendInItalySupportApiBaseUrl, path),
    {
      method,
      headers: jsonHeaders(token),
      body: JSON.stringify(body || {}),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    errorMessage
  )
}

export async function createSupportTicket({token, customerId, category, title, description} = {}) {
  return supportMutation({
    token,
    path: '/facile/support/tickets',
    body: {customer_id: customerId, category, title, description},
    errorMessage: 'Errore creazione ticket assistenza Send in Italy',
  })
}

export async function addSupportTicketArticle({token, ticketId, body, internal = false} = {}) {
  return supportMutation({
    token,
    path: `/facile/support/tickets/${encodeURIComponent(String(ticketId))}/articles`,
    body: {body, internal},
    errorMessage: 'Errore aggiornamento ticket assistenza Send in Italy',
  })
}

export async function updateSupportTicket({token, ticketId, state, priority} = {}) {
  return supportMutation({
    token,
    method: 'PATCH',
    path: `/facile/support/tickets/${encodeURIComponent(String(ticketId))}`,
    body: {state, priority},
    errorMessage: 'Errore modifica ticket assistenza Send in Italy',
  })
}

export async function escalateSupportTicket({token, ticketId} = {}) {
  return supportMutation({
    token,
    path: `/facile/support/tickets/${encodeURIComponent(String(ticketId))}/escalate`,
    errorMessage: 'Errore escalation ticket assistenza Send in Italy',
  })
}
