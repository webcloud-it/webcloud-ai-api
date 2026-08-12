import {randomUUID} from 'node:crypto'
import {mkdir, readFile, appendFile} from 'node:fs/promises'
import {dirname} from 'node:path'

import {env} from '../../config/env.js'

const allowedRatings = new Set(['positive', 'negative'])
const allowedStatuses = new Set(['open', 'resolved', 'ignored'])
const allowedReasons = new Set([
  'helpful',
  'misunderstood',
  'wrong-data',
  'wrong-action',
  'incomplete',
  'unexpected',
  'other',
])
const entries = []
let loaded = false
let writeQueue = Promise.resolve()

function cleanText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\bBearer\s+[a-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}(?:\.[a-z0-9_-]{10,})?/gi, '[REDACTED]')
    .replace(
      /\b(password|passwd|token|api[ _-]?key|auth(?:entication)?[ _-]?code|codice[ _-]?auth)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]'
    )
    .replace(/(:\/\/[^\s:/]+:)[^\s@/]+@/g, '$1[REDACTED]@')
    .trim()
    .slice(0, maxLength)
}

function cleanId(value, maxLength = 120) {
  const candidate = cleanText(value, maxLength)
  return /^[a-z0-9._:-]+$/i.test(candidate) ? candidate : null
}

function cleanContext(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const safe = {}
  for (const key of ['app', 'section', 'path', 'routeName']) {
    const cleaned = cleanText(value[key], key === 'path' ? 500 : 160)
    if (cleaned) safe[key] = cleaned
  }

  if (value.activeEntity && typeof value.activeEntity === 'object') {
    const activeEntity = {}
    for (const key of ['type', 'id', 'slug', 'name', 'label']) {
      const cleaned = cleanText(value.activeEntity[key], 200)
      if (cleaned) activeEntity[key] = cleaned
    }
    if (Object.keys(activeEntity).length) safe.activeEntity = activeEntity
  }

  return safe
}

function remember(entry) {
  const existingIndex = entries.findIndex(item => item.id === entry.id)
  if (existingIndex >= 0) entries.splice(existingIndex, 1)
  entries.push(entry)
  if (entries.length > env.feedbackMaxEntries) {
    entries.splice(0, entries.length - env.feedbackMaxEntries)
  }
}

async function loadEntries() {
  if (loaded) return
  loaded = true

  try {
    const raw = await readFile(env.feedbackStoragePath, 'utf8')
    const parsed = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-env.feedbackMaxEntries)
      .map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    for (const entry of parsed) remember(entry)
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('[ai-feedback-load]', error?.message || error)
  }
}

export async function recordChatFeedback(input = {}, principal = {}) {
  await loadEntries()

  const rating = allowedRatings.has(input.rating) ? input.rating : null
  const reason = allowedReasons.has(input.reason) ? input.reason : null
  if (!rating) throw Object.assign(new Error('Valutazione non valida'), {statusCode: 400})
  if (rating === 'negative' && !reason) {
    throw Object.assign(new Error('Indica il motivo della segnalazione'), {statusCode: 400})
  }

  const entry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    rating,
    status: 'open',
    reason: reason || 'helpful',
    note: cleanText(input.note, 1000) || null,
    requestId: cleanId(input.requestId),
    messageId: cleanId(input.messageId),
    threadId: cleanId(input.threadId),
    userId: cleanId(principal.id),
    moduleId: cleanText(input.moduleId, 120) || null,
    intent: cleanText(input.intent, 160) || null,
    routingSource: cleanText(input.routingSource, 120) || null,
    model: cleanText(input.model, 120) || env.ollamaChatModel,
    question: cleanText(input.question, 4000),
    answer: cleanText(input.answer, 8000),
    context: cleanContext(input.context),
  }

  remember(entry)
  console.info('[ai-feedback]', JSON.stringify(entry))

  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(env.feedbackStoragePath), {recursive: true})
    await appendFile(env.feedbackStoragePath, `${JSON.stringify(entry)}\n`, 'utf8')
  })
  await writeQueue

  return entry
}

export async function updateChatFeedback(id, input = {}, principal = {}) {
  await loadEntries()
  const entry = entries.find(item => item.id === id)
  if (!entry) throw Object.assign(new Error('Segnalazione non trovata'), {statusCode: 404})

  const status = allowedStatuses.has(input.status) ? input.status : null
  if (!status) throw Object.assign(new Error('Stato non valido'), {statusCode: 400})

  const updated = {
    ...entry,
    status,
    resolutionNote: cleanText(input.resolutionNote, 2000) || null,
    resolvedAt: status === 'open' ? null : new Date().toISOString(),
    resolvedBy: status === 'open' ? null : cleanId(principal.id),
  }

  remember(updated)
  console.info('[ai-feedback-status]', JSON.stringify({
    id: updated.id,
    status: updated.status,
    resolvedAt: updated.resolvedAt,
    resolvedBy: updated.resolvedBy,
  }))
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(env.feedbackStoragePath), {recursive: true})
    await appendFile(env.feedbackStoragePath, `${JSON.stringify(updated)}\n`, 'utf8')
  })
  await writeQueue

  return updated
}

export async function getChatFeedback({limit = 100, rating, reason, moduleId, status = 'open'} = {}) {
  await loadEntries()
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000))

  return entries
    .filter(entry => !rating || entry.rating === rating)
    .filter(entry => !reason || entry.reason === reason)
    .filter(entry => !moduleId || entry.moduleId === moduleId)
    .filter(entry => status === 'all' || entry.status === status)
    .slice(-safeLimit)
    .reverse()
}

export const chatFeedbackReasons = [...allowedReasons]
