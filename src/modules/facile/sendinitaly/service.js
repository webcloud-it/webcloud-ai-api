import {env} from '../../../config/env.js'
import {fetchJson, joinUrl} from '../../../utils/http.js'

const DEFAULT_TIMEOUT_MS = 20000

function requireConfiguration() {
  if (!env.sendInItalyApiBaseUrl) {
    const error = new Error('SENDINITALY_API_BASE_URL non configurato')
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
  requireConfiguration()
  requireToken(token)

  return fetchJson(
    joinUrl(
      env.sendInItalyApiBaseUrl,
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
  requireConfiguration()
  requireToken(token)
  if (!ticketId) {
    const error = new Error('Ticket assistenza mancante')
    error.statusCode = 400
    throw error
  }

  return fetchJson(
    joinUrl(
      env.sendInItalyApiBaseUrl,
      `/facile/support/tickets/${encodeURIComponent(String(ticketId))}`
    ),
    {headers: headers(token), timeoutMs: DEFAULT_TIMEOUT_MS},
    'Errore recupero dettaglio ticket assistenza Send in Italy'
  )
}
