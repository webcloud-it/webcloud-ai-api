import crypto from 'node:crypto'
import fetch from 'node-fetch'

import {env} from '../config/env.js'
import {joinUrl} from '../utils/http.js'

const crmIdentityCache = new Map()

function tokenFingerprint(token = '') {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function compactCache(now = Date.now()) {
  if (crmIdentityCache.size < 500) return

  for (const [key, value] of crmIdentityCache) {
    if (value.expiresAt <= now) crmIdentityCache.delete(key)
  }

  while (crmIdentityCache.size > 500) {
    crmIdentityCache.delete(crmIdentityCache.keys().next().value)
  }
}

export async function validateCrmCredential(token, {fetchImpl = fetch} = {}) {
  if (!token || !env.crmDirectusBaseUrl) return null

  const now = Date.now()
  const fingerprint = tokenFingerprint(token)
  const cached = crmIdentityCache.get(fingerprint)
  if (cached?.expiresAt > now) return cached.principal

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), env.authValidationTimeoutMs)

  try {
    const response = await fetchImpl(
      joinUrl(env.crmDirectusBaseUrl, '/users/me?fields=id,email,status,role.id,role.name'),
      {
        headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'},
        signal: controller.signal,
      }
    )

    if (!response.ok) return null

    const payload = await response.json()
    const user = payload?.data
    if (!user?.id || (user.status && user.status !== 'active')) return null
    const roleId = user.role?.id ? String(user.role.id) : null
    if (env.allowedCrmRoleIds.length && !env.allowedCrmRoleIds.includes(roleId)) return null

    const principal = {
      id: String(user.id),
      roleId,
      roleName: typeof user.role?.name === 'string' ? user.role.name : null,
      source: 'crm',
    }

    compactCache(now)
    crmIdentityCache.set(fingerprint, {
      principal,
      expiresAt: now + env.authCacheTtlMs,
    })

    return principal
  } finally {
    clearTimeout(timeout)
  }
}

export function createAuthTokenMiddleware({validateCrmToken = validateCrmCredential} = {}) {
  return async function authTokenMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim()

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: 'Authorization Bearer token mancante',
      })
    }

    const credentials = {
      crm: readHeader(req, 'x-webcloud-credential-crm'),
      webcamgo: readHeader(req, 'x-webcloud-credential-webcamgo'),
      specialk: readHeader(req, 'x-webcloud-credential-specialk'),
      cmsAsiagoIt: readHeader(req, 'x-webcloud-credential-cms-asiago-it'),
      snowbulletin: readHeader(req, 'x-webcloud-credential-snowbulletin'),
      spine01: readHeader(req, 'x-webcloud-credential-spine01'),
      nozomi: readHeader(req, 'x-webcloud-credential-nozomi'),
      wam: readHeader(req, 'x-webcloud-credential-wam'),
    }

    const requestedModuleId = req.body?.moduleId || null
    const legacyCrmRequest = !requestedModuleId || requestedModuleId === 'facile.renewals'
    const crmToken = credentials.crm || (legacyCrmRequest ? token : null)
    let principal = null

    if (crmToken) {
      try {
        principal = await validateCrmToken(crmToken)
      } catch (error) {
        return res.status(503).json({
          ok: false,
          error: 'Validazione della sessione temporaneamente non disponibile',
        })
      }

      if (!principal) {
        return res.status(401).json({
          ok: false,
          error: 'Sessione Facile non valida o scaduta',
        })
      }

      credentials.crm = crmToken
    }

    // I client legacy continuano a poter usare il Bearer come credenziale del
    // modulo, ma le operazioni CRM server-side richiedono sempre una sessione
    // Facile validata sopra.
    if (!credentials.crm && !credentials.webcamgo) {
      credentials.primary = token
    }

    req.auth = {token, credentials, principal}

    next()
  }
}

export const authToken = createAuthTokenMiddleware()

function readHeader(req, name) {
  const value = req.headers?.[name]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
