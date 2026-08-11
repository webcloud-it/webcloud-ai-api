import {randomUUID} from 'node:crypto'

const maxEntries = Math.max(100, Number(process.env.AI_AUDIT_LOG_MAX_ENTRIES || 1000))
const entries = []

function safeRequestId(value) {
  const candidate = String(Array.isArray(value) ? value[0] : value || '').trim()
  return candidate && candidate.length <= 100 && /^[a-z0-9._:-]+$/i.test(candidate)
    ? candidate
    : randomUUID()
}

export function attachRequestId(req, _res, next) {
  req.requestId = safeRequestId(req.headers['x-request-id'])
  next()
}

export function recordChatAudit(entry = {}) {
  const safeEntry = {
    at: new Date().toISOString(),
    requestId: entry.requestId || null,
    requestedModuleId: entry.requestedModuleId || null,
    moduleId: entry.moduleId || null,
    intent: entry.intent || null,
    ok: entry.ok === true,
    source: entry.source || null,
    routingSource: entry.routingSource || null,
    durationMs: Number(entry.durationMs) || 0,
    availableCredentials: Array.isArray(entry.availableCredentials)
      ? entry.availableCredentials.sort()
      : [],
  }

  entries.push(safeEntry)
  if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries)

  console.info('[ai-audit]', JSON.stringify(safeEntry))
  return safeEntry
}

export function getChatAuditEntries({limit = 100} = {}) {
  return entries.slice(-Math.max(1, Math.min(Number(limit) || 100, maxEntries))).reverse()
}

export function getChatAuditSummary({windowMinutes = 60, slowThresholdMs = 5000} = {}) {
  const safeWindowMinutes = Math.max(1, Math.min(Number(windowMinutes) || 60, 24 * 60))
  const since = Date.now() - safeWindowMinutes * 60 * 1000
  const relevant = entries.filter(entry => Date.parse(entry.at) >= since)
  const successes = relevant.filter(entry => entry.ok)
  const failures = relevant.filter(entry => !entry.ok)
  const durations = relevant.map(entry => Number(entry.durationMs) || 0)
  const byModule = new Map()

  for (const entry of relevant) {
    const moduleId = entry.moduleId || entry.requestedModuleId || 'unknown'
    const current = byModule.get(moduleId) || {moduleId, requests: 0, failures: 0, durationMs: 0}
    current.requests += 1
    current.failures += entry.ok ? 0 : 1
    current.durationMs += Number(entry.durationMs) || 0
    byModule.set(moduleId, current)
  }

  return {
    windowMinutes: safeWindowMinutes,
    requests: relevant.length,
    successes: successes.length,
    failures: failures.length,
    successRate: relevant.length ? Math.round((successes.length / relevant.length) * 1000) / 10 : 100,
    averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    maximumDurationMs: durations.length ? Math.max(...durations) : 0,
    slowRequests: durations.filter(value => value >= slowThresholdMs).length,
    modules: [...byModule.values()].map(item => ({
      moduleId: item.moduleId,
      requests: item.requests,
      failures: item.failures,
      averageDurationMs: Math.round(item.durationMs / item.requests),
    })).sort((a, b) => b.requests - a.requests),
    recentFailures: failures.slice(-10).reverse().map(entry => ({
      at: entry.at,
      requestId: entry.requestId,
      moduleId: entry.moduleId || entry.requestedModuleId,
      intent: entry.intent,
      durationMs: entry.durationMs,
    })),
  }
}
