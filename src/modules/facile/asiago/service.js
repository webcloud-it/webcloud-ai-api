import {env} from '../../../config/env.js'
import {authHeaders, fetchJson, joinUrl} from '../../../utils/http.js'

const DEFAULT_TIMEOUT_MS = 20000
const ARTICLE_FIELDS = [
  'idArt',
  'idPaginaMenu',
  'StadiCompletamentoId',
  'dataInizioEvento',
  'dataFineEvento',
  'oraInizio',
  'oraFine',
  'CmsUniqueIdentifier',
  'translations.titoloNotizia',
  'translations.SottoTitoloNotizia',
  'translations.ArticleUrl',
  'translations.pubblica',
  'translations.idAutore.FirstName',
  'translations.idAutore.LastName',
]

function requireConfiguration(baseUrl, settingName) {
  if (!baseUrl) {
    const error = new Error(`${settingName} non configurato`)
    error.statusCode = 503
    throw error
  }
}

function requireToken(token) {
  if (!token) {
    const error = new Error('Credenziale CMS Asiago.it mancante')
    error.statusCode = 401
    throw error
  }
}

function clampLimit(value, fallback = 20) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(50, Math.max(1, Math.trunc(parsed))) : fallback
}

function directusQuery(collection, query, token, errorMessage, baseUrl = env.asiagoCmsBaseUrl, settingName = 'ASIAGO_CMS_BASE_URL') {
  requireConfiguration(baseUrl, settingName)
  requireToken(token)
  return fetchJson(
    joinUrl(baseUrl, `/items/${collection}?${query.toString()}`),
    {headers: {...authHeaders(token), Accept: 'application/json'}, timeoutMs: DEFAULT_TIMEOUT_MS},
    errorMessage
  )
}

function articleQuery({limit, search = '', articleId = null, event = false, upcoming = false} = {}) {
  const query = new URLSearchParams({
    fields: ARTICLE_FIELDS.join(','),
    limit: String(clampLimit(limit)),
    sort: event && upcoming ? 'dataInizioEvento,-idArt' : '-idArt',
    meta: 'filter_count',
    'filter[_and][0][modello][_eq]': 'false',
    'filter[_and][1][idSitoWeb][_eq]': '1',
    'filter[_and][2][idPaginaMenu][_eq]': event ? '34' : undefined,
    'filter[_and][2][idPaginaMenu][_neq]': event ? undefined : '34',
    'deep[translations][_filter][IdLingua][_eq]': '1',
  })

  // URLSearchParams stringifies undefined, so remove optional filters explicitly.
  for (const [key, value] of [...query.entries()]) {
    if (value === 'undefined') query.delete(key)
  }

  let filterIndex = 3
  if (articleId) {
    query.set(`filter[_and][${filterIndex}][idArt][_eq]`, String(articleId))
    filterIndex += 1
  }

  if (search) {
    query.set(`filter[_and][${filterIndex}][_or][0][translations][titoloNotizia][_contains]`, search)
    query.set(`filter[_and][${filterIndex}][_or][1][translations][SottoTitoloNotizia][_contains]`, search)
    query.set(`filter[_and][${filterIndex}][_or][2][translations][NotiziaTestoPlain][_contains]`, search)
    filterIndex += 1
  }

  if (event && upcoming) {
    const today = new Date().toISOString().slice(0, 10)
    query.set(`filter[_and][${filterIndex}][_or][0][dataFineEvento][_gte]`, today)
    query.set(`filter[_and][${filterIndex}][_or][1][_and][0][dataFineEvento][_null]`, 'true')
    query.set(`filter[_and][${filterIndex}][_or][1][_and][1][dataInizioEvento][_gte]`, today)
  }

  return query
}

function normalizeArticle(item = {}) {
  const translation = Array.isArray(item.translations) ? item.translations[0] || {} : {}
  const author = translation.idAutore || {}
  return {
    id: item.idArt ?? null,
    menuId: item.idPaginaMenu ?? null,
    title: translation.titoloNotizia || `Articolo ${item.idArt ?? 'senza ID'}`,
    subtitle: translation.SottoTitoloNotizia || null,
    published: translation.pubblica === true,
    completionStage: item.StadiCompletamentoId ?? null,
    publicUrl: translation.ArticleUrl ? `https://www.asiago.it${translation.ArticleUrl}` : null,
    author: [author.FirstName, author.LastName].filter(Boolean).join(' ') || null,
    event: item.idPaginaMenu === 34
      ? {
          startDate: item.dataInizioEvento || null,
          endDate: item.dataFineEvento || null,
          startTime: item.oraInizio || null,
          endTime: item.oraFine || null,
        }
      : null,
  }
}

function normalizePayload(payload = {}, normalize = value => value) {
  const items = Array.isArray(payload.data) ? payload.data.map(normalize) : []
  return {items, total: Number(payload.meta?.filter_count ?? items.length)}
}

export async function getEvents({token, search = '', upcoming = false, limit = 20, eventId = null} = {}) {
  const payload = await directusQuery(
    'NotiziaArticoli',
    articleQuery({limit, search, articleId: eventId, event: true, upcoming}),
    token,
    'Errore recupero eventi Asiago.it'
  )
  return normalizePayload(payload, normalizeArticle)
}

export async function getContents({token, search = '', limit = 20, contentId = null} = {}) {
  const payload = await directusQuery(
    'NotiziaArticoli',
    articleQuery({limit, search, articleId: contentId}),
    token,
    'Errore recupero contenuti Asiago.it'
  )
  return normalizePayload(payload, normalizeArticle)
}

export async function getMinisites({token, search = '', limit = 20} = {}) {
  const query = new URLSearchParams({
    fields: 'Id,NomeHotel,idTipologia,Tipologia',
    limit: String(clampLimit(limit)),
    sort: '-Id',
    meta: 'filter_count',
    'filter[idTipologia][is_minisito][_eq]': 'true',
  })
  if (search) query.set('filter[NomeHotel][_contains]', search)

  const payload = await directusQuery('Hotel', query, token, 'Errore recupero minisiti Asiago.it')
  return normalizePayload(payload, item => ({
    id: item.Id ?? null,
    name: item.NomeHotel || `Minisito ${item.Id ?? 'senza ID'}`,
    category: {id: item.idTipologia ?? null, name: item.Tipologia || null},
    coverImage: item.Id ? `https://www.asiago.it/it/r/minisito/${item.Id}/foto-copertina/` : null,
  }))
}

export async function getSnowResorts({token, search = '', limit = 20} = {}) {
  const query = new URLSearchParams({
    fields: [
      'SkiResortsId',
      'Name',
      'Location',
      'UpdatedOn',
      'Priority',
      'EnableNotifications',
      'AsiagoitCustomerId',
      'ApiKeysSkiResorts.ApiKeysId.ApiKeysid',
      'ApiKeysSkiResorts.ApiKeysId.Enable',
      'ApiKeysSkiResorts.ApiKeysId.Canonical',
      'ApiKeysSkiResorts.ApiKeysId.ReadOnly',
      'ApiKeysSkiResorts.ApiKeysId.ViewerAlias',
    ].join(','),
    limit: String(clampLimit(limit)),
    sort: 'Priority',
    meta: 'filter_count',
  })
  if (search) {
    query.set('filter[_or][0][Name][_contains]', search)
    query.set('filter[_or][1][Location][_contains]', search)
  }
  const payload = await directusQuery(
    'SkiResorts', query, token, 'Errore recupero bollettino neve',
    env.asiagoSnowBulletinBaseUrl, 'ASIAGO_SNOWBULLETIN_BASE_URL'
  )
  const portalKeyId = 'C7383F75-4D1D-441C-943C-3317283DE967'
  return normalizePayload(payload, item => {
    const keys = (item.ApiKeysSkiResorts || []).map(link => link?.ApiKeysId).filter(Boolean)
    const keyId = key => typeof key === 'string' ? key : key.ApiKeysid
    return {
      id: item.SkiResortsId ?? null,
      name: item.Name || 'Comprensorio senza nome',
      location: item.Location || null,
      updatedOn: item.UpdatedOn || null,
      priority: item.Priority ?? null,
      notificationsEnabled: item.EnableNotifications === true,
      asiagoItCustomerId: item.AsiagoitCustomerId ?? null,
      portalVisible: keys.some(key => keyId(key) === portalKeyId),
      integrations: {
        total: keys.length,
        enabled: keys.filter(key => typeof key === 'object' && key.Enable === true).length,
        hasWriteAccess: keys.some(key => typeof key === 'object' && key.ReadOnly === false),
      },
    }
  })
}

export async function getPricelists({token, search = '', limit = 20} = {}) {
  const query = new URLSearchParams({
    fields: 'AccomodationsId,translations.Name',
    limit: String(clampLimit(limit)),
    meta: 'filter_count',
    'deep[translations][_filter][LanguageCode][_eq]': 'it',
  })
  if (search) query.set('filter[translations][Name][_contains]', search)
  const payload = await directusQuery(
    'Accomodations', query, token, 'Errore recupero listini Asiago.it',
    env.asiagoPricelistsBaseUrl, 'ASIAGO_PRICELISTS_BASE_URL'
  )
  const normalized = normalizePayload(payload, item => ({
    id: item.AccomodationsId ?? null,
    name: item.translations?.[0]?.Name || `Struttura ${item.AccomodationsId ?? 'senza ID'}`,
  }))
  normalized.items.sort((a, b) => a.name.localeCompare(b.name, 'it'))
  return normalized
}

export async function getRedirects({token, search = '', limit = 20} = {}) {
  const query = new URLSearchParams({
    fields: 'id,from_path,to_url,autogenerated,count(redirects_stats)',
    limit: String(clampLimit(limit)),
    sort: '-created_at',
    meta: 'filter_count',
    'filter[_and][0][active][_eq]': 'true',
  })
  if (search) {
    query.set('filter[_and][1][_or][0][from_path][_icontains]', search)
    query.set('filter[_and][1][_or][1][to_url][_icontains]', search)
  }
  const payload = await directusQuery(
    'redirects', query, token, 'Errore recupero redirect Asiago.it',
    env.asiagoNozomiBaseUrl, 'ASIAGO_NOZOMI_BASE_URL'
  )
  return normalizePayload(payload, item => ({
    id: item.id ?? null,
    fromPath: item.from_path || null,
    toUrl: item.to_url || null,
    autogenerated: item.autogenerated === true,
    visits: Number(item['count(redirects_stats)'] || 0),
  }))
}
