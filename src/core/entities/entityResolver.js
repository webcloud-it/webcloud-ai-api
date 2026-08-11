import {normalizeComparableText} from '../../utils/text.js'

const OPEN_COMMAND = /\b(?:apri|aprimi|vai\s+(?:a|al|alla|alle|su|sul|sulla)|portami\s+(?:a|al|alla|alle|su|sul|sulla)|entra\s+(?:in|nel|nella)|visualizza)\b/i

export function isOpenEntityRequest(message = '') {
  return OPEN_COMMAND.test(String(message || ''))
}

export function extractEntityTarget(message = '') {
  const original = String(message || '').trim()
  const quoted = original.match(/["“”']([^"“”']{2,})["“”']/)

  if (quoted?.[1]) return cleanTarget(quoted[1])

  const match = original.match(
    /\b(?:apri|aprimi|vai\s+(?:a|al|alla|alle|su|sul|sulla)|portami\s+(?:a|al|alla|alle|su|sul|sulla)|entra\s+(?:in|nel|nella)|visualizza)\s+(.+)$/i
  )

  return cleanTarget(match?.[1]) || null
}

function cleanTarget(value = '') {
  let target = String(value || '')
    .replace(/[?.!,;:]+$/g, '')
    .replace(/^["“”']+|["“”']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  target = target
    .replace(/\s+(?:su|di|in)\s+(?:webcamgo|send\s*in\s*italy|asiago(?:\.it)?|wam|assets?\s*manager|facile)$/i, '')
    .trim()

  const prefix = /^(?:(?:la|il|lo|le|i|gli|l['’]?)\s*)?(?:(?:webcam|telecamera|evento|minisito|utente|cliente|azienda|applicazione|app|asset|automazione|mattemation|workflow|servizio|dominio|redirect)\s+)?(?:(?:di|del|della|delle|dei|degli|a|al|alla|alle|su|sul|sulla|chiamat[ao])\s+)?/i

  for (let pass = 0; pass < 3; pass += 1) {
    const next = target.replace(prefix, '').trim()
    if (next === target) break
    target = next
  }

  return target || null
}

function levenshtein(left = '', right = '') {
  if (left === right) return 0
  if (!left.length) return right.length
  if (!right.length) return left.length

  let previous = Array.from({length: right.length + 1}, (_, index) => index)

  for (let row = 1; row <= left.length; row += 1) {
    const current = [row]

    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      )
    }

    previous = current
  }

  return previous[right.length]
}

function wordSimilarity(left = '', right = '') {
  const longest = Math.max(left.length, right.length)
  return longest ? 1 - levenshtein(left, right) / longest : 1
}

function scoreValue(value, query, weight = 0) {
  const candidate = normalizeComparableText(value)
  if (!candidate || !query) return 0
  if (candidate === query) return 120 + weight
  if (candidate.startsWith(query)) return 100 + weight
  if (candidate.includes(query)) return 85 + weight

  const queryWords = query.split(' ').filter(Boolean)
  const candidateWords = candidate.split(' ').filter(Boolean)
  if (queryWords.length > 1 && queryWords.every(word => candidateWords.some(item => item.includes(word)))) {
    return 75 + weight
  }

  if (query.length < 5) return 0

  const similarity = Math.max(
    wordSimilarity(candidate, query),
    ...candidateWords.filter(word => word.length >= 4).map(word => wordSimilarity(word, query))
  )

  return similarity >= 0.8 ? 60 + Math.round(similarity * 10) + weight : 0
}

export function resolveNamedEntity({items = [], query = '', fields = []} = {}) {
  const normalizedQuery = normalizeComparableText(query)
  if (!normalizedQuery) return {status: 'missing-target', query}

  const candidates = items
    .map((item, index) => {
      const score = fields.reduce((best, field) => {
        const value = typeof field.value === 'function' ? field.value(item) : item?.[field.value]
        return Math.max(best, scoreValue(value, normalizedQuery, field.weight || 0))
      }, 0)
      return {item, index, score}
    })
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)

  if (!candidates.length) return {status: 'not-found', query}

  const best = candidates[0]
  const runnerUp = candidates[1]
  const strongWinner = !runnerUp || best.score - runnerUp.score >= 12

  if (strongWinner) return {status: 'resolved', query, ...best}

  const plausible = candidates.filter(candidate => best.score - candidate.score <= 12).slice(0, 10)
  if (plausible.length === 1) return {status: 'resolved', query, ...best}

  return {status: 'ambiguous', query, candidates: plausible}
}
