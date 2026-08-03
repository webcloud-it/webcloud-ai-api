import {env} from '../../../config/env.js'
import {authHeaders, fetchJson, joinUrl} from '../../../utils/http.js'
import {createMemoryCache, getCached} from '../../../utils/cache.js'

const DEFAULT_TIMEOUT_MS = Number(
  process.env.CRM_FETCH_TIMEOUT_MS || env.crmFetchTimeoutMs || 10000
)

const SERVICES_CACHE_TTL_MS = Number(
  process.env.RENEWALS_SERVICES_CACHE_TTL_MS || env.renewalsServicesCacheTtlMs || 300000
)

const SETTINGS_CACHE_TTL_MS = Number(
  process.env.RENEWALS_SETTINGS_CACHE_TTL_MS || env.renewalsSettingsCacheTtlMs || 300000
)

const PANEL_COUNTS_CACHE_TTL_MS = Number(
  process.env.RENEWALS_PANEL_COUNTS_CACHE_TTL_MS || env.renewalsPanelCountsCacheTtlMs || 300000
)

const DEFAULT_SETTINGS = {
  analysis_period: 30,
  renewals_low_thresholds: [],
}

const servicesCache = createMemoryCache()
const settingsCache = createMemoryCache()
const panelCountsCache = createMemoryCache()

async function fetchAllServices() {
  return fetchJson(
    joinUrl(env.renewalsApiBaseUrl),
    {
      headers: authHeaders(env.crmToken),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    'Errore API servizi'
  )
}

async function fetchSettings() {
  const url = joinUrl(env.crmDirectusBaseUrl, '/items/settings?filter[app][_eq]=renewals-panel')

  const json = await fetchJson(
    url,
    {
      headers: authHeaders(env.crmToken),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    'Errore recupero settings'
  )

  return json?.data?.[0] || DEFAULT_SETTINGS
}

function buildFallbackSettings(error) {
  return {
    ...DEFAULT_SETTINGS,
    __fallback: true,
    __error: error?.message || 'Settings non disponibili',
  }
}

function buildPanelCountsQuery({analysisPeriod = 30, customerId = null, groupId = null} = {}) {
  const params = new URLSearchParams({
    page: '1',
    pageSize: '1',
    tab: 'tutti',
    analysisPeriod: String(Number(analysisPeriod) || 30),
    dontRenewVisible: 'false',
    expiredVisible: 'false',
    onlyRenewVisible: 'false',
    onlyTransferVisible: 'false',
  })

  if (customerId) {
    params.set('customerId', String(customerId))
  }

  if (groupId) {
    params.set('groupId', String(groupId))
  }

  return params
}

function buildPanelCountsCacheKey({analysisPeriod = 30, customerId = null, groupId = null} = {}) {
  return JSON.stringify({
    analysisPeriod: Number(analysisPeriod) || 30,
    customerId: customerId || null,
    groupId: groupId || null,
  })
}

async function fetchPanelCounts({analysisPeriod = 30, customerId = null, groupId = null} = {}) {
  const params = buildPanelCountsQuery({
    analysisPeriod,
    customerId,
    groupId,
  })

  const [pageJson, storageJson] = await Promise.all([
    fetchJson(
      joinUrl(env.renewalsApiBaseUrl, `/services/page?${params.toString()}`),
      {
        headers: authHeaders(env.crmToken),
        timeoutMs: DEFAULT_TIMEOUT_MS,
      },
      'Errore recupero counter pannello rinnovi'
    ),
    fetchJson(
      joinUrl(env.renewalsApiBaseUrl, `/services/storage-counts?${params.toString()}`),
      {
        headers: authHeaders(env.crmToken),
        timeoutMs: DEFAULT_TIMEOUT_MS,
      },
      'Errore recupero counter spazio rinnovi'
    ),
  ])

  const counts = pageJson?.counts || {}
  const storageCounts = storageJson?.counts || {}

  return {
    all: Number(counts.all ?? 0),
    tableAll: Number(counts.tableAll ?? 0),
    renewal: Number(counts.renewal ?? 0),
    autoRenew: Number(counts.autoRenew ?? 0),
    providers: Number(counts.providers ?? 0),
    billing: Number(counts.billing ?? 0),
    dontRenew: Number(counts.dontRenew ?? 0),
    fullSpace: Number(storageCounts.fullSpace ?? counts.fullSpace ?? 0),
    lowSpace: Number(storageCounts.lowSpace ?? counts.lowSpace ?? 0),
    analysisPeriod: Number(analysisPeriod) || 30,
  }
}

export async function getAllServices({force = false} = {}) {
  if (force) {
    const value = await fetchAllServices()

    servicesCache.value = value
    servicesCache.expiresAt = Date.now() + SERVICES_CACHE_TTL_MS

    return value
  }

  return getCached(servicesCache, SERVICES_CACHE_TTL_MS, fetchAllServices, {
    logPrefix: '[renewals-services]',
  })
}

export async function getSettings({force = false} = {}) {
  try {
    if (force) {
      const value = await fetchSettings()
      settingsCache.value = value
      settingsCache.expiresAt = Date.now() + SETTINGS_CACHE_TTL_MS
      return value
    }

    return await getCached(settingsCache, SETTINGS_CACHE_TTL_MS, fetchSettings, {
      logPrefix: '[renewals-settings]',
    })
  } catch (error) {
    if (settingsCache.value) {
      console.warn('[renewals-settings] using stale cache:', error.message)

      return {
        ...settingsCache.value,
        __stale: true,
        __error: error.message,
      }
    }

    console.warn('[renewals-settings] using fallback settings:', error.message)

    return buildFallbackSettings(error)
  }
}

export async function getPanelCounts({
  force = false,
  analysisPeriod = 30,
  customerId = null,
  groupId = null,
} = {}) {
  const key = buildPanelCountsCacheKey({
    analysisPeriod,
    customerId,
    groupId,
  })

  if (!panelCountsCache.value) {
    panelCountsCache.value = new Map()
  }

  const scopedCache = panelCountsCache.value.get(key) || createMemoryCache()

  if (force) {
    const value = await fetchPanelCounts({
      analysisPeriod,
      customerId,
      groupId,
    })

    scopedCache.value = value
    scopedCache.expiresAt = Date.now() + PANEL_COUNTS_CACHE_TTL_MS
    panelCountsCache.value.set(key, scopedCache)

    return value
  }

  try {
    const value = await getCached(
      scopedCache,
      PANEL_COUNTS_CACHE_TTL_MS,
      () =>
        fetchPanelCounts({
          analysisPeriod,
          customerId,
          groupId,
        }),
      {
        logPrefix: '[renewals-panel-counts]',
      }
    )

    panelCountsCache.value.set(key, scopedCache)

    return value
  } catch (error) {
    if (scopedCache.value) {
      console.warn('[renewals-panel-counts] using stale cache:', error.message)

      return {
        ...scopedCache.value,
        __stale: true,
        __error: error.message,
      }
    }

    console.warn('[renewals-panel-counts] unavailable:', error.message)

    return {
      all: null,
      tableAll: null,
      renewal: null,
      autoRenew: null,
      providers: null,
      billing: null,
      dontRenew: null,
      fullSpace: null,
      lowSpace: null,
      analysisPeriod: Number(analysisPeriod) || 30,
      __fallback: true,
      __error: error.message,
    }
  }
}

const ALLOWED_SERVICE_FLAG_FIELDS = new Set(['toRenew', 'dontRenew', 'autoRenew'])

function validateServiceFlagMutation(expected = {}, changes = {}) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new Error('expected obbligatorio')
  }

  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new Error('changes obbligatorio')
  }

  const changeKeys = Object.keys(changes)
  const expectedKeys = Object.keys(expected)

  if (changeKeys.length < 1 || changeKeys.length > 3) {
    throw new Error('È necessario modificare da uno a tre flag')
  }

  if (
    expectedKeys.length !== changeKeys.length ||
    !changeKeys.every(field => expectedKeys.includes(field))
  ) {
    throw new Error('expected e changes devono contenere gli stessi flag')
  }

  for (const field of changeKeys) {
    if (!ALLOWED_SERVICE_FLAG_FIELDS.has(field)) {
      throw new Error(`Flag non supportato: ${field}`)
    }

    if (typeof expected[field] !== 'boolean' || typeof changes[field] !== 'boolean') {
      throw new Error(`expected.${field} e changes.${field} devono essere booleani`)
    }
  }

  return changeKeys
}

function updateServiceFlagsInCache(serviceId, flags = {}) {
  if (!Array.isArray(servicesCache.value)) {
    return
  }

  const service = servicesCache.value.find(item => String(item?.id) === String(serviceId))

  if (!service) {
    return
  }

  if (typeof flags.toRenew === 'boolean') {
    service.toRenew = flags.toRenew
    service.to_renew = flags.toRenew
  }

  if (typeof flags.dontRenew === 'boolean') {
    service.dontRenew = flags.dontRenew
    service.dont_renew = flags.dontRenew
  }

  if (typeof flags.autoRenew === 'boolean') {
    service.autoRenew = flags.autoRenew
    service.auto_renew = flags.autoRenew
  }
}

export function invalidateRenewalsServicesCache() {
  servicesCache.value = null
  servicesCache.expiresAt = 0
}

export function invalidateRenewalsPanelCountsCache() {
  panelCountsCache.value = new Map()
  panelCountsCache.expiresAt = 0
}

export async function updateServiceFlags({
  serviceId,
  expected = null,
  changes = null,
  actionId = null,
} = {}) {
  if (!serviceId) {
    throw new Error('serviceId obbligatorio')
  }

  validateServiceFlagMutation(expected, changes)

  const result = await fetchJson(
    joinUrl(env.renewalsApiBaseUrl, `/services/${encodeURIComponent(serviceId)}/flags`),
    {
      method: 'PATCH',
      headers: {
        ...authHeaders(env.crmToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        actionId,
        expected,
        changes,
      }),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    'Errore aggiornamento flag servizio'
  )

  updateServiceFlagsInCache(serviceId, result?.service?.flags || changes)

  invalidateRenewalsPanelCountsCache()

  return result
}
