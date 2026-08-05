import {createHash} from 'node:crypto'

const READ_QUERY_CONTEXT_TTL_MS = 30 * 60 * 1000
const contexts = new Map()

function fingerprintToken(token = '') {
  return createHash('sha256')
    .update(String(token || ''))
    .digest('hex')
    .slice(0, 24)
}

function cleanupExpiredContexts(now = Date.now()) {
  for (const [key, context] of contexts.entries()) {
    if (!context || context.expiresAt <= now) {
      contexts.delete(key)
    }
  }
}

function normalizeResultState({plan = null, result = null} = {}) {
  if (!plan?.entity || !result?.ok || result?.type !== 'read-query-result') {
    return null
  }

  const offset = Number(result.offset || plan.offset || 0)
  const shown = Number(
    result.shown ?? (Array.isArray(result.items) ? result.items.length : 0)
  )
  const limit = Number(result.limit || plan.limit || 20)

  return {
    plan,
    entity: plan.entity,
    total: Number(result.total || 0),
    shown,
    offset,
    limit,
    hasMore: result.hasMore === true,
    nextOffset: Number(result.nextOffset ?? offset + shown),
    previousOffset: Number(result.previousOffset ?? Math.max(offset - limit, 0)),
    items: Array.isArray(result.items) ? result.items : [],
    dataSource: result.dataSource || null,
  }
}

export function rememberReadQueryContext({actorToken = '', plan = null, result = null} = {}) {
  if (!actorToken) return null

  const state = normalizeResultState({plan, result})
  if (!state) return null

  cleanupExpiredContexts()

  contexts.set(fingerprintToken(actorToken), {
    state,
    expiresAt: Date.now() + READ_QUERY_CONTEXT_TTL_MS,
  })

  return state
}

export function getRememberedReadQueryContext({actorToken = ''} = {}) {
  if (!actorToken) return null

  cleanupExpiredContexts()

  return contexts.get(fingerprintToken(actorToken))?.state || null
}

export function clearRememberedReadQueryContext({actorToken = ''} = {}) {
  if (!actorToken) return false
  return contexts.delete(fingerprintToken(actorToken))
}

export function clearAllReadQueryContexts() {
  contexts.clear()
}
