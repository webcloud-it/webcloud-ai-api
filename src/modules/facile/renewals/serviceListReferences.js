import {normalizeComparableText, normalizeSearchText} from '../../../utils/text.js'

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
  ['nono', 9],
  ['nona', 9],
  ['decimo', 10],
  ['decima', 10],
])

function hasDetailOperation(message = '') {
  return /\b(dettagli|dettaglio|scheda|approfondisci|dimmi di piu|informazioni|info|analizza|controlla|verifica)\b/i.test(
    normalizeSearchText(message)
  )
}

function extractPositionSelector(message = '') {
  const text = normalizeSearchText(message)

  if (/\bultimo\b/i.test(text)) {
    return {
      kind: 'position',
      position: 'last',
    }
  }

  if (/\bpenultimo\b/i.test(text)) {
    return {
      kind: 'position',
      position: 'penultimate',
    }
  }

  for (const [word, position] of ORDINALS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) {
      return {
        kind: 'position',
        position,
      }
    }
  }

  const numeric = text.match(
    /\b(?:del|della|il|la|numero|n\.?|posizione|riga)\s*(\d{1,2})(?:\s*[°º])?\b/i
  )

  if (!numeric?.[1]) {
    return null
  }

  const position = Number(numeric[1])

  return position > 0
    ? {
        kind: 'position',
        position,
      }
    : null
}

function extractTextSelector(message = '') {
  const match = String(message || '').match(
    /\b(?:quell[oa]|quest[oa])\s+(?:di|del|della|con|contenente)\s+(.+)$/i
  )

  const term = String(match?.[1] || '')
    .replace(/[?.!,;:]+$/g, '')
    .replace(/^(?:fornitore|provider|supplier|piano|plan|cliente|azienda|gruppo|dominio|servizio)\s+/i, '')
    .trim()

  return term
    ? {
        kind: 'text',
        term,
      }
    : null
}

function isBarePositionReference(message = '') {
  const text = normalizeSearchText(message)

  return /^(?:(?:il|la)\s+)?(?:numero|n\.?|riga|posizione)?\s*\d{1,2}(?:\s*[°º])?$/.test(text)
}

export function parseServiceListSelector(message = '') {
  return extractPositionSelector(message) || extractTextSelector(message)
}

export function parseServiceListReferenceRequest(message = '', {allowBarePosition = false} = {}) {
  const selector = parseServiceListSelector(message)

  if (!selector) {
    return null
  }

  const hasOperation = hasDetailOperation(message)
  const isBarePosition =
    allowBarePosition && selector.kind === 'position' && isBarePositionReference(message)

  if (!hasOperation && !isBarePosition) {
    return null
  }

  return {
    type: 'service-list-reference',
    operation: 'detail',
    selector,
  }
}

function getReferenceText(value) {
  if (!value) return null
  if (typeof value === 'object') return value.name || value.label || value.id || null
  return value
}

function getItemSearchFields(item = {}) {
  return [
    {value: item.servizio, weight: 8},
    {value: item.dominio, weight: 8},
    {value: item.cliente, weight: 4},
    {value: item.gruppo, weight: 2},
    {value: item.piano, weight: 1},
    {value: getReferenceText(item.fornitore), weight: 4},
    {value: getReferenceText(item.provider), weight: 4},
    {value: getReferenceText(item.supplier), weight: 4},
    ...(item.fornitori || []).map(provider => ({
      value: getReferenceText(provider),
      weight: 4,
    })),
    ...(item.piani || []).flatMap(plan => [
      {
        value: plan?.name,
        weight: 1,
      },
      {
        value: getReferenceText(plan?.supplier),
        weight: 4,
      },
    ]),
  ].filter(field => field.value)
}

function scoreField(value, term, weight = 0) {
  const field = normalizeComparableText(value)
  const needle = normalizeComparableText(term)

  if (!field || !needle) return 0
  if (field === needle) return 100 + weight
  if (field.startsWith(needle)) return 80 + weight
  if (field.includes(needle)) return 60 + weight

  return 0
}

function scoreItem(item, term) {
  return getItemSearchFields(item).reduce((best, field) => {
    return Math.max(best, scoreField(field.value, term, field.weight))
  }, 0)
}

export function resolveServiceListReference({request = null, items = []} = {}) {
  if (!request?.selector) {
    return {
      status: 'not-applicable',
    }
  }

  const safeItems = Array.isArray(items) ? items : []

  if (!safeItems.length) {
    return {
      status: 'empty-list',
    }
  }

  if (request.selector.kind === 'position') {
    const requestedPosition = request.selector.position

    const index =
      requestedPosition === 'last'
        ? safeItems.length - 1
        : requestedPosition === 'penultimate'
          ? safeItems.length - 2
          : Number(requestedPosition) - 1

    if (!Number.isInteger(index) || index < 0 || index >= safeItems.length) {
      return {
        status: 'out-of-range',
        requestedPosition,
        available: safeItems.length,
      }
    }

    return {
      status: 'resolved',
      index,
      item: safeItems[index],
    }
  }

  const candidates = safeItems
    .map((item, index) => ({
      item,
      index,
      score: scoreItem(item, request.selector.term),
    }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)

  if (!candidates.length) {
    return {
      status: 'not-found',
      term: request.selector.term,
    }
  }

  const bestScore = candidates[0].score
  const bestCandidates = candidates.filter(candidate => candidate.score === bestScore)

  if (bestCandidates.length > 1) {
    return {
      status: 'ambiguous',
      term: request.selector.term,
      candidates: bestCandidates,
    }
  }

  return {
    status: 'resolved',
    index: candidates[0].index,
    item: candidates[0].item,
  }
}
