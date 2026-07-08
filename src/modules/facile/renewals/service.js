import fetch from 'node-fetch'

import {env} from '../../../config/env.js'

const DEFAULT_TIMEOUT_MS = Number(
  process.env.CRM_FETCH_TIMEOUT_MS || env.crmFetchTimeoutMs || 10000
)

const SERVICES_CACHE_TTL_MS = Number(
  process.env.RENEWALS_SERVICES_CACHE_TTL_MS || env.renewalsServicesCacheTtlMs || 300000
)

const SETTINGS_CACHE_TTL_MS = Number(
  process.env.RENEWALS_SETTINGS_CACHE_TTL_MS || env.renewalsSettingsCacheTtlMs || 300000
)

const DEFAULT_SETTINGS = {
  analysis_period: 30,
  renewals_low_thresholds: [],
}

const servicesCache = {
  value: null,
  expiresAt: 0,
  promise: null,
}

const settingsCache = {
  value: null,
  expiresAt: 0,
  promise: null,
}

function joinUrl(baseUrl, path = '') {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  }
}

async function readJson(res, errorMessage) {
  if (!res.ok) {
    const body = await res.text()

    throw new Error(`${errorMessage} (${res.status})\n${body}`)
  }

  return res.json()
}

async function fetchJson(url, options = {}, errorMessage = 'Errore API') {
  const controller = new AbortController()
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)

  const timeout = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    })

    return readJson(res, errorMessage)
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`${errorMessage}: timeout dopo ${timeoutMs}ms`)
    }

    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function refreshCache(cache, ttlMs, loader) {
  if (cache.promise) {
    return cache.promise
  }

  cache.promise = loader()
    .then(value => {
      cache.value = value
      cache.expiresAt = Date.now() + ttlMs
      return value
    })
    .finally(() => {
      cache.promise = null
    })

  return cache.promise
}

async function getCached(cache, ttlMs, loader) {
  const now = Date.now()

  if (cache.value && cache.expiresAt > now) {
    return cache.value
  }

  if (cache.value) {
    refreshCache(cache, ttlMs, loader).catch(error => {
      console.warn('[renewals-cache] refresh failed:', error.message)
    })

    return cache.value
  }

  return refreshCache(cache, ttlMs, loader)
}

async function fetchAllServices() {
  return fetchJson(
    joinUrl(env.renewalsApiBaseUrl),
    {
      headers: authHeaders(env.crmToken),
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

export async function getAllServices({force = false} = {}) {
  if (force) {
    return fetchAllServices()
  }

  return getCached(servicesCache, SERVICES_CACHE_TTL_MS, fetchAllServices)
}

export async function getSettings({force = false} = {}) {
  try {
    if (force) {
      const value = await fetchSettings()
      settingsCache.value = value
      settingsCache.expiresAt = Date.now() + SETTINGS_CACHE_TTL_MS
      return value
    }

    return await getCached(settingsCache, SETTINGS_CACHE_TTL_MS, fetchSettings)
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
