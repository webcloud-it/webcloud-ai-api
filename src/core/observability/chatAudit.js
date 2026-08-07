import {randomUUID} from 'node:crypto'

const maxEntries = Math.max(100, Number(process.env.AI_AUDIT_LOG_MAX_ENTRIES || 1000))
const entries = []

export function attachRequestId(req, _res, next) {
  req.requestId = req.headers['x-request-id'] || randomUUID()
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
