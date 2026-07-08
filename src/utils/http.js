import fetch from 'node-fetch'

export function joinUrl(baseUrl, path = '') {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

export function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  }
}

export async function readJson(res, errorMessage = 'Errore API') {
  if (!res.ok) {
    const body = await res.text()

    throw new Error(`${errorMessage} (${res.status})\n${body}`)
  }

  return res.json()
}

export async function fetchJson(url, options = {}, errorMessage = 'Errore API') {
  const {timeoutMs = 10000, ...fetchOptions} = options

  const controller = new AbortController()

  const timeout = setTimeout(() => {
    controller.abort()
  }, Number(timeoutMs))

  try {
    const res = await fetch(url, {
      ...fetchOptions,
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
