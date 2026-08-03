import {normalizeSearchText} from '../../../utils/text.js'

function isServiceListNextFollowUpText(text = '') {
  return (
    /\b(?:mostramene|dammene|elencamene)\s+(?:altr[ei]\s+)?\d{1,2}\b/i.test(text) ||
    /\b(?:altr[ei]|successiv[ei]|prossim[ei]|seguent[ei])(?:\s+\d{1,2})?\b/i.test(text) ||
    /\b(?:continua|prosegui|vai avanti|avanti|ancora)\b/i.test(text) ||
    /\b(?:pagina)\s+(?:dopo|successiva|seguente)\b/i.test(text) ||
    /\b(?:mostra|mostrami|dammi|elenca|elencami)\s+(?:gli\s+|i\s+)?(?:altr[ei]|successiv[ei]|prossim[ei])(?:\s+\d{1,2})?(?:\s+(?:servizi|risultati|voci))?\b/i.test(
      text
    ) ||
    /\bfammi\s+vedere\s+(?:gli\s+|i\s+)?(?:altr[ei]|successiv[ei]|prossim[ei])(?:\s+\d{1,2})?(?:\s+(?:servizi|risultati|voci))?\b/i.test(
      text
    )
  )
}

function isServiceListPreviousFollowUpText(text = '') {
  return (
    /\b(?:precedent[ei]|indietro)\b/i.test(text) ||
    /\btorna\s+indietro\b/i.test(text) ||
    /\bpagina\s+(?:precedente|prima)\b/i.test(text)
  )
}

function isServiceListFirstPageFollowUpText(text = '') {
  return (
    /\b(?:mostrami|mostra|dammi|fammi vedere|elencami|elenca)?\s*(?:i\s+|le\s+)?prim[ei]\s+\d{1,2}\b/i.test(
      text
    ) ||
    /\b(?:torna|riparti|ricomincia)\s+(?:da|dai|dalle)\s+(?:i\s+|le\s+)?prim[ei](?:\s+\d{1,2})?\b/i.test(
      text
    )
  )
}

function extractServiceListFollowUpLimit(text = '') {
  const patterns = [
    /\b(?:mostrami|mostra|dammi|fammi vedere|elencami|elenca)?\s*(?:i\s+|le\s+)?prim[ei]\s+(\d{1,2})\b/i,
    /\b(?:mostramene|dammene|elencamene)\s+(?:altr[ei]\s+)?(\d{1,2})\b/i,
    /\b(?:altr[ei]|successiv[ei]|prossim[ei]|seguent[ei])\s+(\d{1,2})\b/i,
    /\b(?:mostra|mostrami|dammi|elenca|elencami)\s+(?:gli\s+|i\s+)?(?:altr[ei]|successiv[ei]|prossim[ei])\s+(\d{1,2})\b/i,
    /\bfammi\s+vedere\s+(?:gli\s+|i\s+)?(?:altr[ei]|successiv[ei]|prossim[ei])\s+(\d{1,2})\b/i,
    /\b(?:ancora|altri)\s+(\d{1,2})\b/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)

    if (match?.[1]) {
      return clampServiceListFollowUpLimit(match[1])
    }
  }

  return null
}

function clampServiceListFollowUpLimit(value) {
  const number = Number.parseInt(String(value ?? ''), 10)

  if (!Number.isFinite(number)) {
    return null
  }

  return Math.min(Math.max(number, 1), 50)
}

export function parseServiceListPaginationRequest(message = '') {
  const text = normalizeSearchText(message)

  if (!text) {
    return null
  }

  const direction = isServiceListFirstPageFollowUpText(text)
    ? 'first'
    : isServiceListPreviousFollowUpText(text)
      ? 'previous'
      : isServiceListNextFollowUpText(text)
        ? 'next'
        : null

  if (!direction) {
    return null
  }

  return {
    direction,
    limit: extractServiceListFollowUpLimit(text),
  }
}

export function buildServiceListPagination(previousState, request) {
  if (!previousState || !request) {
    return null
  }

  const limit = request.limit || previousState.limit || 20
  const shown = previousState.shown || previousState.limit || limit
  const currentOffset = previousState.offset || 0

  if (request.direction === 'first') {
    return {
      direction: 'first',
      limit,
      offset: 0,
      sourceMessage: previousState.sourceMessage,
    }
  }

  if (request.direction === 'previous') {
    if (currentOffset <= 0) {
      return {
        blockedReason: 'at-start',
      }
    }

    return {
      direction: 'previous',
      limit,
      offset: Math.max(currentOffset - limit, 0),
      sourceMessage: previousState.sourceMessage,
    }
  }

  if (previousState.hasMore === false) {
    return {
      blockedReason: 'no-more-results',
    }
  }

  return {
    direction: 'next',
    limit,
    offset: Number.isFinite(previousState.nextOffset)
      ? previousState.nextOffset
      : currentOffset + shown,
    sourceMessage: previousState.sourceMessage,
  }
}
