import {createHash} from 'node:crypto'

import {getReadEntityRegistry} from './readEntityRegistry.js'
import {
  extractReadQueryDetailTarget,
  isReadQueryDetailRequest,
} from './readQueryReferences.js'

const READ_QUERY_CLARIFICATION_TTL_MS = 10 * 60 * 1000
const pendingClarifications = new Map()

const ORDINALS = new Map([
  ['primo', 1],
  ['prima', 1],
  ['secondo', 2],
  ['seconda', 2],
  ['terzo', 3],
  ['terza', 3],
  ['quarto', 4],
  ['quarta', 4],
  ['quinto', 5],
  ['quinta', 5],
  ['sesto', 6],
  ['sesta', 6],
  ['settimo', 7],
  ['settima', 7],
  ['ottavo', 8],
  ['ottava', 8],
])

function fingerprintToken(token = '') {
  return createHash('sha256')
    .update(String(token || ''))
    .digest('hex')
    .slice(0, 24)
}

function normalizeText(value = '') {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[?.!,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanupExpiredClarifications(now = Date.now()) {
  for (const [key, pending] of pendingClarifications.entries()) {
    if (!pending || pending.expiresAt <= now) {
      pendingClarifications.delete(key)
    }
  }
}

function normalizeCandidate(candidate = {}) {
  if (!candidate?.entityId || !candidate?.filter) return null

  return {
    entityId: candidate.entityId,
    entityLabel: candidate.entityLabel || null,
    entitySingular: candidate.entitySingular || null,
    name: candidate.name || null,
    source: candidate.source || null,
    filter: candidate.filter,
  }
}

function getCandidateAliases(candidate = {}) {
  const definition = getReadEntityRegistry().get(candidate.entityId)

  return [...new Set([
    candidate.entityId,
    candidate.entityLabel,
    candidate.entitySingular,
    definition?.label,
    definition?.singular,
    ...(definition?.aliases || []),
  ])]
    .filter(Boolean)
    .map(normalizeText)
    .filter(Boolean)
    .sort((first, second) => second.length - first.length)
}

function extractPosition(message = '') {
  const text = normalizeText(message)
  const numeric = text.match(/^(?:(?:opzione|numero|n)\s*)?(\d{1,2})$/i)

  if (numeric?.[1]) {
    const position = Number(numeric[1])
    return position > 0 ? position : null
  }

  for (const [word, position] of ORDINALS) {
    if (new RegExp(`^(?:(?:la|il|l'opzione|opzione)\\s+)?${word}$`, 'i').test(text)) {
      return position
    }
  }

  return null
}

function containsAlias(text = '', alias = '') {
  if (!text || !alias) return false
  if (text === alias) return true

  const paddedText = ` ${text} `
  const paddedAlias = ` ${alias} `
  return paddedText.includes(paddedAlias)
}

function resolveByEntityAlias(message = '', candidates = []) {
  const text = normalizeText(message)
  const matches = candidates.filter(candidate =>
    getCandidateAliases(candidate).some(alias => containsAlias(text, alias))
  )

  if (!matches.length) return null

  const entityIds = new Set(matches.map(candidate => candidate.entityId))
  if (entityIds.size !== 1) return null

  const entityMatches = candidates.filter(candidate => candidate.entityId === matches[0].entityId)
  return entityMatches.length === 1 ? entityMatches[0] : null
}

function resolveByCandidateName(message = '', candidates = []) {
  const text = normalizeText(message)
  const matches = candidates.filter(candidate => {
    const name = normalizeText(candidate.name)
    return name && (text === name || text.includes(name))
  })

  return matches.length === 1 ? matches[0] : null
}

function isNewExplicitDetailRequest(message = '', pending = {}, readUtterance = null) {
  if (!isReadQueryDetailRequest(message, readUtterance)) return false

  const target = normalizeText(extractReadQueryDetailTarget(message, readUtterance))
  const pendingTarget = normalizeText(pending.target)

  if (!target || target === pendingTarget) return false

  const candidateAliases = pending.candidates.flatMap(getCandidateAliases)
  if (candidateAliases.includes(target)) return false

  return true
}

function isLikelySelectionAttempt(message = '', candidates = []) {
  const text = normalizeText(message)
  if (!text) return false

  if (extractPosition(text) !== null) return true
  if (/\b(?:intendo|intendevo|scelgo|scegli|opzione|quello|quella|tipo|entita)\b/i.test(text)) {
    return true
  }

  return candidates.some(candidate =>
    getCandidateAliases(candidate).some(alias => containsAlias(text, alias))
  )
}

function buildResolvedTarget(candidate = {}, pending = {}) {
  return {
    status: 'resolved',
    target: pending.target,
    entityId: candidate.entityId,
    entityLabel: candidate.entityLabel,
    entitySingular: candidate.entitySingular,
    name: candidate.name,
    filter: candidate.filter,
    source: candidate.source,
    reason: 'clarification-selection',
  }
}

export function rememberReadQueryTargetClarification({
  actorToken = '',
  resolution = null,
} = {}) {
  if (!actorToken || resolution?.status !== 'ambiguous') return null

  const candidates = (resolution.candidates || [])
    .map(normalizeCandidate)
    .filter(Boolean)

  if (candidates.length < 2) return null

  cleanupExpiredClarifications()

  const pending = {
    target: resolution.target || null,
    candidates,
    expiresAt: Date.now() + READ_QUERY_CLARIFICATION_TTL_MS,
  }

  pendingClarifications.set(fingerprintToken(actorToken), pending)
  return pending
}

export function getPendingReadQueryTargetClarification({actorToken = ''} = {}) {
  if (!actorToken) return null

  cleanupExpiredClarifications()
  return pendingClarifications.get(fingerprintToken(actorToken)) || null
}

export function hasPendingReadQueryTargetClarification({actorToken = ''} = {}) {
  return Boolean(getPendingReadQueryTargetClarification({actorToken}))
}

export function clearPendingReadQueryTargetClarification({actorToken = ''} = {}) {
  if (!actorToken) return false
  return pendingClarifications.delete(fingerprintToken(actorToken))
}

export function clearAllPendingReadQueryTargetClarifications() {
  pendingClarifications.clear()
}

export function resolvePendingReadQueryTargetClarification({
  actorToken = '',
  message = '',
  readUtterance = null,
} = {}) {
  const pending = getPendingReadQueryTargetClarification({actorToken})

  if (!pending) return {status: 'not-pending'}

  if (isNewExplicitDetailRequest(message, pending, readUtterance)) {
    clearPendingReadQueryTargetClarification({actorToken})
    return {status: 'not-applicable'}
  }

  const position = extractPosition(message)
  if (position !== null) {
    const candidate = pending.candidates[position - 1]

    if (!candidate) {
      return {status: 'invalid', pending, reason: 'position-out-of-range'}
    }

    clearPendingReadQueryTargetClarification({actorToken})
    return {
      status: 'resolved',
      resolution: buildResolvedTarget(candidate, pending),
    }
  }

  const candidate =
    resolveByEntityAlias(message, pending.candidates) ||
    resolveByCandidateName(message, pending.candidates)

  if (candidate) {
    clearPendingReadQueryTargetClarification({actorToken})
    return {
      status: 'resolved',
      resolution: buildResolvedTarget(candidate, pending),
    }
  }

  if (isLikelySelectionAttempt(message, pending.candidates)) {
    return {status: 'invalid', pending, reason: 'selection-not-resolved'}
  }

  clearPendingReadQueryTargetClarification({actorToken})
  return {status: 'not-applicable'}
}
