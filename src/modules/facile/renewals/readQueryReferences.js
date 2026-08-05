function normalizeText(value = '') {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cleanTarget(value = '') {
  return String(value || '')
    .replace(/[?.!,;:]+$/g, '')
    .replace(/^[\s:'"“”,-]+|[\s:'"“”,-]+$/g, '')
    .replace(/^(?:dell['’]|sull['’]|della|dello|degli|delle|sulla|sullo|del|sul|di|su)\s*/i, '')
    .replace(/^(?:quell[oa]|quest[oa])\s+(?:con|contenente|di|del|della)\s+/i, '')
    .trim()
}

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

export function isReadQueryDetailRequest(message = '', readUtterance = null) {
  if (readUtterance?.operation === 'detail') return true

  return /\b(?:dettagli|dettaglio|scheda|informazioni|info|descrivi|descrizione|approfondisci|dimmi di piu|parlami|raccontami|spiegami|illustrami|presentami)\b/i.test(
    normalizeText(message)
  )
}

export function extractReadQueryDetailPosition(message = '') {
  const text = normalizeText(message)

  if (/\bultimo\b/i.test(text)) return 'last'
  if (/\bpenultimo\b/i.test(text)) return 'penultimate'

  for (const [word, position] of ORDINALS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) return position
  }

  const numeric =
    text.match(/\b(?:numero|n\.?|riga|posizione)\s*(\d{1,2})(?:\s*[°º])?\b/i) ||
    text.match(
      /^(?:dettagli|dettaglio|scheda|informazioni|info)(?:\s+(?:del|della|dell'|dello))?\s+(\d{1,2})(?:\s*[°º])?$/i
    )

  if (!numeric?.[1]) return null

  const position = Number(numeric[1])
  return position > 0 ? position : null
}

function resolvePosition(items = [], position = null) {
  const safeItems = Array.isArray(items) ? items : []
  if (!safeItems.length || position === null) return null

  const index =
    position === 'last'
      ? safeItems.length - 1
      : position === 'penultimate'
        ? safeItems.length - 2
        : Number(position) - 1

  if (!Number.isInteger(index) || index < 0 || index >= safeItems.length) return null

  return safeItems[index]
}

export function extractReadQueryDetailTarget(message = '', readUtterance = null) {
  if (readUtterance?.operation === 'detail' && readUtterance?.target) {
    return cleanTarget(readUtterance.target)
  }

  const text = String(message || '').trim()
  const quoted = text.match(/["“”']([^"“”']{2,})["“”']/)
  if (quoted?.[1]) return cleanTarget(quoted[1])

  const patterns = [
    /^(?:dammi|mostrami|fammi vedere|dimmi)?\s*(?:i\s+)?(?:dettagli|dettaglio|scheda|informazioni|info|descrivi|descrizione|approfondisci|dimmi di piu)(?:\s+(?:dell['’]|sull['’]|della|dello|degli|delle|sulla|sullo|del|sul|di|su))?\s+(.+)$/i,
    /^(?:cosa|che cosa)\s+sai\s+(?:su|di)\s+(.+)$/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    const target = cleanTarget(match?.[1])
    if (target) return target
  }

  return null
}

function stripEntityPrefix(target = '', entity = null) {
  let value = cleanTarget(target)
  if (!value || !entity) return value

  const aliases = [entity.singular, entity.label, ...(entity.aliases || [])]
    .filter(Boolean)
    .sort((first, second) => String(second).length - String(first).length)
    .map(escapeRegExp)

  if (!aliases.length) return value

  const prefix = new RegExp(
    `^(?:(?:il|lo|la|i|gli|le|un|una)\\s+)?(?:${aliases.join('|')})(?:\\s+|$)`,
    'i'
  )

  value = value.replace(prefix, '').trim()
  return cleanTarget(value)
}

function getTargetField(entityId = '') {
  return entityId === 'plan-prices' ? 'plan.name' : 'name'
}

function getItemIdentity(item = {}, entityId = '') {
  if (item?.id !== null && item?.id !== undefined && item?.id !== '') {
    return {
      field: 'id',
      operator: 'equals',
      value: String(item.id),
    }
  }

  const name =
    entityId === 'plan-prices'
      ? item?.plan?.name || item?.name
      : item?.name || item?.label

  if (!name) return null

  return {
    field: getTargetField(entityId),
    operator: 'equals',
    value: name,
  }
}

export function buildReadQueryDetailReference({
  message = '',
  explicitEntity = null,
  previousState = null,
  readUtterance = null,
} = {}) {
  if (!isReadQueryDetailRequest(message, readUtterance)) return null

  const entity = explicitEntity || previousState?.entityDefinition || null
  const entityId = entity?.id || previousState?.entity || null

  if (!entityId || entityId === 'services') return null

  const position = extractReadQueryDetailPosition(message)
  const selectedItem = resolvePosition(previousState?.items, position)
  const selectedIdentity = selectedItem ? getItemIdentity(selectedItem, entityId) : null

  if (selectedIdentity) {
    return {
      entityId,
      filter: selectedIdentity,
      limit: 1,
      reason: 'previous-result-position',
    }
  }

  const rawTarget = extractReadQueryDetailTarget(message, readUtterance)
  const target = stripEntityPrefix(rawTarget, entity)

  if (!target) return null

  return {
    entityId,
    filter: {
      field: getTargetField(entityId),
      operator: 'contains',
      value: target,
    },
    limit: 10,
    reason: explicitEntity ? 'explicit-entity-target' : 'previous-entity-target',
  }
}
