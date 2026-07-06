import fetch from 'node-fetch'

import {env} from '../../../config/env.js'

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

export async function getAllServices() {
  const res = await fetch(joinUrl(env.renewalsApiBaseUrl), {
    headers: authHeaders(env.crmToken),
  })

  return readJson(res, 'Errore API servizi')
}

export async function getSettings() {
  const url = joinUrl(env.crmDirectusBaseUrl, '/items/settings?filter[app][_eq]=renewals-panel')

  const res = await fetch(url, {
    headers: authHeaders(env.crmToken),
  })

  const json = await readJson(res, 'Errore recupero settings')
  return json?.data?.[0] || {}
}
