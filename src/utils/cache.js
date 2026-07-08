export function createMemoryCache(initialValue = null) {
  return {
    value: initialValue,
    expiresAt: 0,
    promise: null,
  }
}

export function refreshCache(cache, ttlMs, loader) {
  if (cache.promise) {
    return cache.promise
  }

  cache.promise = loader()
    .then(value => {
      cache.value = value
      cache.expiresAt = Date.now() + Number(ttlMs)
      return value
    })
    .finally(() => {
      cache.promise = null
    })

  return cache.promise
}

export async function getCached(cache, ttlMs, loader, options = {}) {
  const now = Date.now()
  const logPrefix = options.logPrefix || '[cache]'

  if (cache.value && cache.expiresAt > now) {
    return cache.value
  }

  if (cache.value) {
    refreshCache(cache, ttlMs, loader).catch(error => {
      console.warn(`${logPrefix} refresh failed:`, error.message)
    })

    return cache.value
  }

  return refreshCache(cache, ttlMs, loader)
}
