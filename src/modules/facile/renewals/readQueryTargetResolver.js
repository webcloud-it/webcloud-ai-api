import {
  buildReadEntityRecords,
  getReadEntityDefinitions,
  getReadEntityRegistry,
} from './readEntityRegistry.js'
import {
  extractReadQueryDetailPosition,
  extractReadQueryDetailTarget,
  isReadQueryDetailRequest,
} from './readQueryReferences.js'

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,}$/i
const CONTEXT_ONLY_TARGETS = new Set([
  'questo',
  'questa',
  'quello',
  'quella',
  'questi',
  'queste',
  'quelli',
  'quelle',
  'stesso',
  'stessa',
  'lo stesso',
  'la stessa',
])
const REMOTE_RESOLUTION_LIMIT = 10

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
    .trim()
}

function getEntityDefinitions() {
  return getReadEntityDefinitions()
    .map(definition => getReadEntityRegistry().get(definition.id))
    .filter(Boolean)
}

function buildTargetVariants(rawTarget = '') {
  const target = cleanTarget(rawTarget)
  if (!target) return []

  const variants = [{target, entityHint: null, source: 'raw'}]
  const definitions = getEntityDefinitions()
  const aliases = definitions
    .flatMap(definition =>
      [definition.singular, definition.label, ...(definition.aliases || [])]
        .filter(Boolean)
        .map(alias => ({definition, alias: String(alias)}))
    )
    .sort((first, second) => second.alias.length - first.alias.length)

  for (const entry of aliases) {
    const pattern = new RegExp(
      `^(?:(?:il|lo|la|i|gli|le|un|una)\\s+)?${escapeRegExp(entry.alias)}(?:\\s+|$)`,
      'i'
    )

    if (!pattern.test(target)) continue

    const stripped = cleanTarget(target.replace(pattern, ''))
    if (!stripped) continue

    variants.push({
      target: stripped,
      entityHint: entry.definition.id,
      source: 'entity-prefix',
    })
    break
  }

  return variants.filter(
    (variant, index, source) =>
      source.findIndex(
        item =>
          normalizeText(item.target) === normalizeText(variant.target) &&
          item.entityHint === variant.entityHint
      ) === index
  )
}

function getCanonicalNames(item = {}, entityId = '') {
  const values = []

  if (entityId === 'plan-prices') {
    values.push(item?.plan?.name, item?.name)
  } else {
    values.push(item?.name, item?.label)
  }

  if (entityId === 'services') {
    values.push(item?.domain?.name)
  }

  if (entityId === 'domains') {
    values.push(item?.service?.name)
  }

  if (entityId === 'price-lists' && item?.version !== null && item?.version !== undefined) {
    values.push(`${item?.name || ''} ${item.version}`)
  }

  return [...new Set(values.filter(Boolean).map(value => String(value).trim()))]
}

function getTargetField(entityId = '') {
  return entityId === 'plan-prices' ? 'plan.name' : 'name'
}

function getCandidateIdentity(item = {}, entityId = '', matchedName = '') {
  if (item?.id !== null && item?.id !== undefined && item?.id !== '') {
    return {
      field: 'id',
      operator: 'equals',
      value: String(item.id),
    }
  }

  return {
    field: getTargetField(entityId),
    operator: 'equals',
    value: matchedName,
  }
}

function buildCandidate({definition, item, matchedName, matchKind, source}) {
  return {
    entityId: definition.id,
    entityLabel: definition.label,
    entitySingular: definition.singular,
    item,
    name: matchedName,
    normalizedName: normalizeText(matchedName),
    matchKind,
    source,
    filter: getCandidateIdentity(item, definition.id, matchedName),
  }
}

function matchRecords({definition, records = [], target = '', source = 'operational'}) {
  const normalizedTarget = normalizeText(target)
  if (!normalizedTarget) return []

  const candidates = []

  for (const item of records) {
    const names = getCanonicalNames(item, definition.id)

    for (const name of names) {
      const normalizedName = normalizeText(name)
      if (!normalizedName) continue

      const matchKind =
        normalizedName === normalizedTarget
          ? 'exact'
          : normalizedName.startsWith(normalizedTarget)
            ? 'prefix'
            : normalizedName.includes(normalizedTarget)
              ? 'contains'
              : null

      if (!matchKind) continue

      candidates.push(
        buildCandidate({
          definition,
          item,
          matchedName: name,
          matchKind,
          source,
        })
      )
      break
    }
  }

  return candidates
}

function dedupeCandidates(candidates = []) {
  const map = new Map()

  for (const candidate of candidates) {
    const key = [
      candidate.entityId,
      candidate.item?.id || '',
      candidate.normalizedName,
    ].join('|')

    if (!map.has(key)) map.set(key, candidate)
  }

  return [...map.values()]
}

function pickBestCandidates(candidates = [], {target = '', entityHint = null} = {}) {
  let pool = dedupeCandidates(candidates)
  if (!pool.length) return []

  if (entityHint) {
    const hinted = pool.filter(candidate => candidate.entityId === entityHint)
    if (hinted.length) pool = hinted
  }

  const exact = pool.filter(candidate => candidate.matchKind === 'exact')
  if (exact.length) pool = exact
  else {
    const prefix = pool.filter(candidate => candidate.matchKind === 'prefix')
    if (prefix.length) pool = prefix
  }

  if (DOMAIN_PATTERN.test(normalizeText(target))) {
    const services = pool.filter(candidate => candidate.entityId === 'services')
    if (services.length) return services
  }

  const serviceCandidates = pool.filter(candidate => candidate.entityId === 'services')
  const domainCandidates = pool.filter(candidate => candidate.entityId === 'domains')

  if (serviceCandidates.length && domainCandidates.length) {
    pool = pool.filter(candidate => candidate.entityId !== 'domains')
  }

  return dedupeCandidates(pool)
}

function collapseSameEntityCandidates(candidates = []) {
  if (!candidates.length) return null

  const entityIds = new Set(candidates.map(candidate => candidate.entityId))
  const names = new Set(candidates.map(candidate => candidate.normalizedName))

  if (entityIds.size !== 1 || names.size !== 1) return null

  const first = candidates[0]

  return {
    ...first,
    filter: {
      field: getTargetField(first.entityId),
      operator: 'equals',
      value: first.name,
    },
  }
}

function buildResolved(candidate, target, reason) {
  return {
    status: 'resolved',
    target,
    entityId: candidate.entityId,
    entityLabel: candidate.entityLabel,
    entitySingular: candidate.entitySingular,
    name: candidate.name,
    filter: candidate.filter,
    source: candidate.source,
    reason,
  }
}

function resolveCandidateSet(candidates = [], {target = '', entityHint = null} = {}) {
  const best = pickBestCandidates(candidates, {target, entityHint})

  if (!best.length) return null
  if (best.length === 1) return buildResolved(best[0], target, 'unique-match')

  const collapsed = collapseSameEntityCandidates(best)
  if (collapsed) return buildResolved(collapsed, target, 'same-entity-same-name')

  return {
    status: 'ambiguous',
    target,
    candidates: best.slice(0, 8).map(candidate => ({
      entityId: candidate.entityId,
      entityLabel: candidate.entityLabel,
      entitySingular: candidate.entitySingular,
      name: candidate.name,
      source: candidate.source,
      filter: candidate.filter,
    })),
  }
}

function shouldSearchPlanPrices(message = '', entityHint = null) {
  if (entityHint === 'plan-prices') return true
  return /\b(?:prezz[oi]|cost[oi]|tariff[ae]|quanto costa)\b/i.test(normalizeText(message))
}

async function resolveFromCatalog({
  message = '',
  variant,
  queryCatalog,
} = {}) {
  if (typeof queryCatalog !== 'function') return null

  const definitions = getEntityDefinitions().filter(definition => {
    if (!definition.catalog?.enabled) return false
    if (definition.id === 'plan-prices' && !shouldSearchPlanPrices(message, variant.entityHint)) {
      return false
    }
    return !variant.entityHint || definition.id === variant.entityHint
  })

  const settled = await Promise.allSettled(
    definitions.map(async definition => {
      const field = getTargetField(definition.id)
      const result = await queryCatalog({
        type: 'read-query-plan',
        operation: 'detail',
        entity: definition.id,
        filters: [{field, operator: 'equals', value: variant.target}],
        sort: definition.defaultSort || [{field, direction: 'asc'}],
        limit: REMOTE_RESOLUTION_LIMIT,
        offset: 0,
        source: 'detail-target-resolution',
        sourceMessage: message,
      })

      return matchRecords({
        definition,
        records: Array.isArray(result?.items) ? result.items : [],
        target: variant.target,
        source: 'catalog',
      })
    })
  )

  return settled.flatMap(result => (result.status === 'fulfilled' ? result.value : []))
}

export function shouldResolveReadQueryDetailTarget(message = '', readUtterance = null) {
  if (!isReadQueryDetailRequest(message, readUtterance)) return false
  if (extractReadQueryDetailPosition(message) !== null) return false

  const target = extractReadQueryDetailTarget(message, readUtterance)
  if (!target) return false

  return !CONTEXT_ONLY_TARGETS.has(normalizeText(target))
}

export async function resolveReadQueryDetailTarget({
  message = '',
  services = [],
  options = {},
  queryCatalog = null,
  readUtterance = null,
} = {}) {
  if (!shouldResolveReadQueryDetailTarget(message, readUtterance)) {
    return {status: 'not-applicable'}
  }

  const rawTarget = extractReadQueryDetailTarget(message, readUtterance)
  const variants = buildTargetVariants(rawTarget)

  if (readUtterance?.entityHint) {
    variants.unshift({
      target: rawTarget,
      entityHint: readUtterance.entityHint,
      source: readUtterance.source || 'utterance-entity-hint',
    })
  }
  const definitions = getEntityDefinitions().filter(
    definition => definition.id !== 'plan-prices' || shouldSearchPlanPrices(message)
  )

  for (const variant of variants) {
    const scopedDefinitions = variant.entityHint
      ? definitions.filter(definition => definition.id === variant.entityHint)
      : definitions
    const operationalCandidates = scopedDefinitions.flatMap(definition =>
      matchRecords({
        definition,
        records: buildReadEntityRecords(definition.id, {services, options}),
        target: variant.target,
        source: 'operational-services',
      })
    )
    const operationalResolution = resolveCandidateSet(operationalCandidates, variant)

    if (operationalResolution?.status === 'resolved') return operationalResolution
    if (operationalResolution?.status === 'ambiguous') return operationalResolution
  }

  for (const variant of variants) {
    const catalogCandidates = await resolveFromCatalog({
      message,
      variant,
      queryCatalog,
    })
    const catalogResolution = resolveCandidateSet(catalogCandidates || [], variant)

    if (catalogResolution) return catalogResolution
  }

  return {
    status: 'not-found',
    target: variants[variants.length - 1]?.target || rawTarget,
  }
}

function formatCandidate(candidate = {}) {
  const entity = candidate.entitySingular || candidate.entityLabel || candidate.entityId
  return `${entity} “${candidate.name}”`
}

export function buildReadQueryTargetClarification(resolution = {}) {
  if (resolution.status === 'ambiguous') {
    const candidateRows = []
    const seen = new Set()

    for (const candidate of resolution.candidates || []) {
      const label = formatCandidate(candidate)
      if (seen.has(label)) continue
      seen.add(label)
      candidateRows.push({label, candidate})
    }

    const entityChoices = [...new Set(
      candidateRows
        .map(row => row.candidate.entitySingular || row.candidate.entityLabel)
        .filter(Boolean)
    )]

    const selectionHint = entityChoices.length <= 4
      ? `Rispondi con ${[
          ...entityChoices.map(value => `“${value}”`),
          ...candidateRows.map((_, index) => `“${index + 1}”`),
        ].join(', ').replace(/, ([^,]*)$/, ' oppure $1')}.`
      : 'Rispondi con il tipo di entità oppure con il numero dell’opzione.'

    return [
      `“${resolution.target}” corrisponde a più entità:`,
      ...candidateRows.map((row, index) => `${index + 1}. ${row.label}`),
      '',
      selectionHint,
    ].join('\n')
  }

  return [
    `Non ho trovato con certezza a quale entità appartiene “${resolution.target || 'il valore indicato'}”.`,
    'Specifica se si tratta di un servizio, piano, add-on, fornitore, cliente, gruppo, risorsa, tipo di servizio o listino.',
  ].join(' ')
}
