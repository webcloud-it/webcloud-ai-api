import {env} from '../../../config/env.js'
import {authHeaders, fetchJson, joinUrl} from '../../../utils/http.js'

const TIMEOUT_MS = 20000

function requireValue(value, message, statusCode = 503) {
  if (value) return
  const error = new Error(message)
  error.statusCode = statusCode
  throw error
}

function limitValue(value, fallback = 20) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(50, Math.max(1, Math.trunc(parsed))) : fallback
}

function directus(collection, query, {baseUrl, token, label}) {
  requireValue(baseUrl, `${label} non configurato`)
  requireValue(token, `Credenziale ${label} mancante`, 401)
  return fetchJson(
    joinUrl(baseUrl, `/items/${collection}?${query.toString()}`),
    {headers: {...authHeaders(token), Accept: 'application/json'}, timeoutMs: TIMEOUT_MS},
    `Errore recupero ${label}`
  )
}

function payload(raw = {}, map = value => value) {
  const items = Array.isArray(raw.data) ? raw.data.map(map) : []
  return {items, total: Number(raw.meta?.filter_count ?? items.length)}
}

export async function getWamApplications({token, search = '', limit = 20} = {}) {
  const query = new URLSearchParams({fields: 'id,name,s3_bucket_name', limit: String(limitValue(limit)), meta: 'filter_count'})
  if (search) query.set('filter[name][_icontains]', search)
  const raw = await directus('applications', query, {baseUrl: env.wamCmsBaseUrl, token, label: 'WAM'})
  return payload(raw, item => ({id: item.id ?? null, name: item.name || 'Applicazione senza nome', bucketName: item.s3_bucket_name || null}))
}

export async function getWamAssets({token, applicationId = '', search = '', shortId = '', limit = 20} = {}) {
  const query = new URLSearchParams({fields: 'id,short_id,title,type,mimetype,width,height,application_id', limit: String(limitValue(limit)), meta: 'filter_count'})
  let index = 0
  if (applicationId) query.set(`filter[_and][${index++}][application_id][_eq]`, applicationId)
  if (shortId) query.set(`filter[_and][${index++}][short_id][_eq]`, shortId)
  if (search) {
    query.set(`filter[_and][${index}][_or][0][title][_icontains]`, search)
    query.set(`filter[_and][${index}][_or][1][short_id][_icontains]`, search)
  }
  const raw = await directus('assets', query, {baseUrl: env.wamCmsBaseUrl, token, label: 'WAM'})
  return payload(raw, item => ({
    id: item.id ?? null,
    shortId: item.short_id || null,
    title: item.title || item.short_id || 'Asset senza titolo',
    type: item.type || null,
    mimetype: item.mimetype || null,
    width: Number(item.width || 0) || null,
    height: Number(item.height || 0) || null,
    applicationId: typeof item.application_id === 'object' ? item.application_id?.id : item.application_id || null,
  }))
}

export async function getCloudflareBuckets({limit = 50} = {}) {
  requireValue(env.cloudflareCacheApiBaseUrl, 'CLOUDFLARE_CACHE_API_BASE_URL non configurato')
  const raw = await fetchJson(joinUrl(env.cloudflareCacheApiBaseUrl, '/buckets'), {timeoutMs: TIMEOUT_MS}, 'Errore recupero bucket cache Cloudflare')
  const values = Array.isArray(raw) ? raw : []
  const items = values.slice(0, limitValue(limit, 50)).map(item => ({
    name: String(item.name || '').slice(0, 120),
    pattern: String(item.pattern || '').slice(0, 300),
    browserMaxAge: Number(item.browserMaxAge || 0),
    cdnMaxAge: Number(item.cdnMaxAge || 0),
    timestamp: Number(item.timestamp || 0) || null,
  }))
  return {items, total: values.length}
}

export async function getHolidays({token, from, to, limit = 50} = {}) {
  const today = new Date()
  const start = from || today.toISOString().slice(0, 10)
  const endDate = new Date(today)
  endDate.setDate(endDate.getDate() + 183)
  const end = to || endDate.toISOString().slice(0, 10)
  const query = new URLSearchParams({
    fields: 'id,type,from,to,name,member.name,member.surname',
    limit: String(limitValue(limit, 50)),
    sort: 'from',
    meta: 'filter_count',
    'filter[_and][0][from][_lte]': end,
    'filter[_and][1][to][_gte]': start,
  })
  const raw = await directus('holidays', query, {baseUrl: env.crmDirectusBaseUrl, token, label: 'calendario festività'})
  const typeNames = {1: 'festività', 2: 'ferie', 3: 'malattia'}
  return payload(raw, item => ({
    id: item.id ?? null,
    type: typeNames[Number(item.type)] || 'assenza',
    from: item.from || null,
    to: item.to || item.from || null,
    name: Number(item.type) === 1 ? item.name || 'Festività' : [item.member?.name, item.member?.surname].filter(Boolean).join(' ') || 'Membro non disponibile',
  }))
}

export async function getAutomations({token, search = '', includeUnlisted = false, limit = 50} = {}) {
  const query = new URLSearchParams({
    fields: 'id,name,description,inputs,trigger_url,external_workflow_id,wam_short_id,icon,unlisted',
    limit: String(limitValue(limit, 50)),
    sort: 'name',
    meta: 'filter_count',
  })
  if (search) query.set('filter[name][_icontains]', search)
  if (!includeUnlisted) query.set('filter[unlisted][_neq]', 'true')
  const raw = await directus('mattemations', query, {baseUrl: env.asiagoNozomiBaseUrl, token, label: 'automazioni'})
  return payload(raw, item => ({
    id: item.id ?? null,
    name: item.name || 'Automazione senza nome',
    description: item.description || null,
    runnable: Boolean(item.trigger_url),
    externalWorkflowId: item.external_workflow_id || null,
    inputs: (Array.isArray(item.inputs) ? item.inputs : []).slice(0, 20).map(input => ({
      name: input.name || input.label || input.key || null,
      type: input.type || null,
      optional: input.optional === true,
    })),
  }))
}
