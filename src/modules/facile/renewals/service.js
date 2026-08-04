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

const SERVICE_OPTIONS_CACHE_TTL_MS = Number(
  process.env.RENEWALS_SERVICE_OPTIONS_CACHE_TTL_MS || 300000
)

const PLESK_AUDIT_TIMEOUT_MS = Number(
  process.env.PLESK_AUDIT_TIMEOUT_MS || 120000
)

const DEFAULT_SETTINGS = {
  analysis_period: 30,
  renewals_low_thresholds: [],
}

const servicesCache = createMemoryCache()
const settingsCache = createMemoryCache()
const panelCountsCache = createMemoryCache()
const serviceOptionsCache = createMemoryCache()

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

async function fetchServiceOptions() {
  const json = await fetchJson(
    joinUrl(env.renewalsApiBaseUrl, '/services/options'),
    {
      headers: authHeaders(env.crmToken),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    'Errore recupero opzioni servizi'
  )

  return {
    customers: Array.isArray(json?.customers) ? json.customers : [],
    groups: Array.isArray(json?.groups) ? json.groups : [],
    serviceTypes: Array.isArray(json?.serviceTypes) ? json.serviceTypes : [],
    providers: Array.isArray(json?.providers) ? json.providers : [],
  }
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

export async function getServiceOptions({force = false} = {}) {
  if (force) {
    const value = await fetchServiceOptions()

    serviceOptionsCache.value = value
    serviceOptionsCache.expiresAt = Date.now() + SERVICE_OPTIONS_CACHE_TTL_MS

    return value
  }

  return getCached(serviceOptionsCache, SERVICE_OPTIONS_CACHE_TTL_MS, fetchServiceOptions, {
    logPrefix: '[renewals-service-options]',
  })
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


export async function getPleskRenewalsAudit() {
  if (!env.facileIntegrationsApiBaseUrl) {
    throw new Error('FACILE_INTEGRATIONS_API_BASE_URL non configurato')
  }

  if (!env.facileAccessToken) {
    throw new Error('ACCESS_TOKEN non configurato per crm-integrations-api')
  }

  return fetchJson(
    joinUrl(env.facileIntegrationsApiBaseUrl, '/plesk/audit-renewals'),
    {
      headers: authHeaders(env.facileAccessToken),
      timeoutMs: PLESK_AUDIT_TIMEOUT_MS,
    },
    'Errore audit Plesk rinnovi'
  )
}

function normalizeHttpCheckDomain(value = '') {
  const normalized = String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .toLowerCase()

  const hostnamePattern =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

  return hostnamePattern.test(normalized) ? normalized : null
}

export async function checkServiceHttpResponse({domain, protocol = 'auto'} = {}) {
  const normalizedDomain = normalizeHttpCheckDomain(domain)

  if (!normalizedDomain) {
    throw new Error('Dominio non valido')
  }

  const normalizedProtocol = String(protocol || 'auto').toLowerCase()

  if (!['auto', 'http', 'https'].includes(normalizedProtocol)) {
    throw new Error('Protocollo di controllo non supportato')
  }

  /*
   * L'endpoint applicativo attuale prova HTTPS e usa HTTP come fallback
   * quando il tentativo HTTPS non è raggiungibile. Il protocollo richiesto
   * viene mantenuto dal chiamante come preferenza conversazionale, ma il
   * backend applicativo resta l'autorità sul controllo effettivo.
   */
  const body = {
    domain: normalizedDomain,
  }

  return fetchJson(
    joinUrl(env.renewalsApiBaseUrl, '/check-site-response'),
    {
      method: 'POST',
      headers: {
        ...authHeaders(env.crmToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    'Errore verifica risposta HTTP/HTTPS del dominio'
  )
}

const ALLOWED_SERVICE_FLAG_FIELDS = new Set([
  'toRenew',
  'dontRenew',
  'autoRenew',
  'toTransfer',
  'invoiceDate',
  'pleskPlansSync',
  'authCode',
])

function normalizeNullableId(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  if (typeof value === 'object') {
    return value?.id ? String(value.id) : null
  }

  const normalized = String(value).trim()

  return normalized || null
}


function normalizeAuthCodeValue(value) {
  if (value === null || value === undefined) return null

  const normalized = String(value).trim()

  return normalized || null
}

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
    throw new Error('È necessario modificare da uno a tre campi')
  }

  if (
    expectedKeys.length !== changeKeys.length ||
    !changeKeys.every(field => expectedKeys.includes(field))
  ) {
    throw new Error('expected e changes devono contenere gli stessi campi')
  }

  const dedicatedFields = changeKeys.filter(field =>
    ['toTransfer', 'invoiceDate', 'pleskPlansSync', 'authCode'].includes(field)
  )

  if (dedicatedFields.length && changeKeys.length !== 1) {
    throw new Error(`${dedicatedFields[0]} deve essere modificato con un’operazione dedicata`)
  }

  for (const field of changeKeys) {
    if (!ALLOWED_SERVICE_FLAG_FIELDS.has(field)) {
      throw new Error(`Campo non supportato: ${field}`)
    }

    if (field === 'toTransfer') {
      const expectedId = normalizeNullableId(expected[field])
      const changedId = normalizeNullableId(changes[field])

      if (expected[field] != null && !expectedId) {
        throw new Error('expected.toTransfer deve essere un ID fornitore o null')
      }

      if (changes[field] != null && !changedId) {
        throw new Error('changes.toTransfer deve essere un ID fornitore o null')
      }

      continue
    }

    if (field === 'invoiceDate') {
      for (const [containerName, value] of [['expected', expected[field]], ['changes', changes[field]]]) {
        if (value !== null && (typeof value !== 'string' || Number.isNaN(new Date(value).getTime()))) {
          throw new Error(`${containerName}.invoiceDate deve essere una data valida o null`)
        }
      }
      continue
    }

    if (field === 'authCode') {
      for (const [containerName, value] of [['expected', expected[field]], ['changes', changes[field]]]) {
        const normalized = normalizeAuthCodeValue(value)

        if (value !== null && typeof value !== 'string') {
          throw new Error(`${containerName}.authCode deve essere una stringa o null`)
        }

        if (normalized && normalized.length > 512) {
          throw new Error(`${containerName}.authCode supera la lunghezza massima consentita`)
        }
      }
      continue
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

  if (Object.prototype.hasOwnProperty.call(flags, 'toTransfer')) {
    const provider = flags.toTransfer
      ? {
          id: normalizeNullableId(flags.toTransfer),
          name: typeof flags.toTransfer === 'object' ? flags.toTransfer?.name || null : null,
        }
      : null

    service.toTransfer = provider
    service.to_transfer = provider?.id || null
  }

  if (Object.prototype.hasOwnProperty.call(flags, 'invoiceDate')) {
    service.invoiceDate = flags.invoiceDate || null
    service.invoice_date = flags.invoiceDate || null
  }

  if (typeof flags.pleskPlansSync === 'boolean') {
    service.pleskPlansSync = flags.pleskPlansSync
    service.plesk_plans_sync = flags.pleskPlansSync
  }

  if (Object.prototype.hasOwnProperty.call(flags, 'authCode')) {
    const authCode = normalizeAuthCodeValue(flags.authCode)

    service.authCode = authCode
    service.auth_code = authCode
  }
}


function updateSubscriptionEndDateInCache(serviceId, subscriptionId, endsOn) {
  if (!Array.isArray(servicesCache.value)) return

  const service = servicesCache.value.find(item => String(item?.id) === String(serviceId))
  if (!service) return

  const targetId = String(subscriptionId || '')
  const seen = new Set()

  const visit = subscription => {
    if (!subscription || seen.has(subscription)) return false
    seen.add(subscription)

    if (String(subscription?.id || '') === targetId) {
      subscription.endsOn = endsOn || null
      subscription.ends_on = endsOn || null
      return true
    }

    const children =
      subscription?.suppliersSubscriptions ||
      subscription?.suppliers_subscriptions ||
      subscription?.suppliersSubscriptionsChildren ||
      []

    for (const child of Array.isArray(children) ? children : []) {
      if (visit(child?.related_subscriptions_id || child)) return true
    }

    return false
  }

  for (const subscription of Array.isArray(service?.subscriptions) ? service.subscriptions : []) {
    if (visit(subscription)) return
  }
}

function validateNullableDate(value, fieldName) {
  if (value === null) return

  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`${fieldName} deve essere una data valida o null`)
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

  const cacheFlags = {
    ...(result?.service?.flags || {}),
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'authCode')) {
    cacheFlags.authCode = normalizeAuthCodeValue(changes.authCode)
  }

  updateServiceFlagsInCache(serviceId, cacheFlags)

  invalidateRenewalsPanelCountsCache()

  return result
}

export async function updateSubscriptionEndDate({
  serviceId,
  subscriptionId,
  expectedEndDate = null,
  newEndDate = null,
  expectedIsSupplier,
  actionId = null,
} = {}) {
  if (!serviceId) throw new Error('serviceId obbligatorio')
  if (!subscriptionId) throw new Error('subscriptionId obbligatorio')

  validateNullableDate(expectedEndDate, 'expectedEndDate')
  validateNullableDate(newEndDate, 'newEndDate')

  if (typeof expectedIsSupplier !== 'boolean') {
    throw new Error('expectedIsSupplier deve essere booleano')
  }

  const result = await fetchJson(
    joinUrl(
      env.renewalsApiBaseUrl,
      `/services/${encodeURIComponent(serviceId)}/subscriptions/${encodeURIComponent(
        subscriptionId
      )}/end-date`
    ),
    {
      method: 'PATCH',
      headers: {
        ...authHeaders(env.crmToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        actionId,
        expectedEndDate,
        newEndDate,
        expectedIsSupplier,
      }),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    'Errore aggiornamento scadenza sottoscrizione'
  )

  updateSubscriptionEndDateInCache(
    serviceId,
    subscriptionId,
    result?.subscription?.endsOn ?? newEndDate
  )

  invalidateRenewalsPanelCountsCache()

  return result
}

export async function copySupplierExpiryToCustomer({
  serviceId,
  customerSubscriptionId,
  supplierSubscriptionId,
  expectedCustomerEndDate = null,
  expectedSupplierEndDate = null,
  actionId = null,
} = {}) {
  if (!serviceId) throw new Error('serviceId obbligatorio')
  if (!customerSubscriptionId) throw new Error('customerSubscriptionId obbligatorio')
  if (!supplierSubscriptionId) throw new Error('supplierSubscriptionId obbligatorio')

  validateNullableDate(expectedCustomerEndDate, 'expectedCustomerEndDate')
  validateNullableDate(expectedSupplierEndDate, 'expectedSupplierEndDate')

  if (!expectedSupplierEndDate) {
    throw new Error('expectedSupplierEndDate obbligatorio')
  }

  const result = await fetchJson(
    joinUrl(
      env.renewalsApiBaseUrl,
      `/services/${encodeURIComponent(serviceId)}/subscriptions/${encodeURIComponent(
        customerSubscriptionId
      )}/copy-supplier-end-date`
    ),
    {
      method: 'PATCH',
      headers: {
        ...authHeaders(env.crmToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        actionId,
        supplierSubscriptionId,
        expectedCustomerEndDate,
        expectedSupplierEndDate,
      }),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    'Errore copia scadenza fornitore sulla sottoscrizione cliente'
  )

  updateSubscriptionEndDateInCache(
    serviceId,
    customerSubscriptionId,
    result?.subscription?.endsOn ?? expectedSupplierEndDate
  )

  invalidateRenewalsPanelCountsCache()

  return result
}

