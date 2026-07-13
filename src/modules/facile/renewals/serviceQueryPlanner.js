import {buildBareRenewalsEntityServiceListMessage} from './intents.js'
import {parseServiceListQuery} from './serviceQueries.js'

const FILTER_FAMILIES = {
  'customer-or-group': 'scope',
  'plan': 'plan',
  'supplier': 'supplier',
  'service-type': 'service-type',
  'status': 'status',
  'space-full': 'space',
  'space-low': 'space',
  'dont-renew': 'dont-renew',
  'to-renew': 'to-renew',
  'to-transfer': 'to-transfer',
  'auto-renew': 'auto-renew',
  'no-auto-renew': 'auto-renew',
  'has-plesk': 'plesk',
  'no-plesk': 'plesk',
  'plesk-sync': 'plesk-sync',
  'no-plesk-sync': 'plesk-sync',
  'has-domain-record': 'domain-record',
  'no-domain-record': 'domain-record',
  'has-auth-code': 'auth-code',
  'no-auth-code': 'auth-code',
  'has-communications': 'communications',
  'no-communications': 'communications',
  'has-traffic': 'traffic',
  'missing-price': 'missing-price',
  'billing': 'billing',
  'expiring': 'expiry',
  'expired': 'expiry',
  'expired-over-month': 'expiry',
  'expires-in-range': 'expiry',
  'supplier-expires-in-range': 'supplier-expiry',
}

function normalizeText(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
}

function compact(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isExplicitSummaryRequest(message = '') {
  return /\b(riepilogo|riassunto|situazione|panoramica|overview|come siamo messi|stato generale)\b/i.test(
    normalizeText(message)
  )
}

function hasExplicitListAnchor(message = '') {
  return /\b(servizi?|domini?|elenco|lista)\b/i.test(message)
}

function hasExplicitScopeAnchor(message = '') {
  return /\b(cliente|azienda|gruppo)\b/i.test(message)
}

function hasAnyQueryAnchor(message = '') {
  return hasExplicitListAnchor(message) || hasExplicitScopeAnchor(message)
}

function hasContextReference(message = '') {
  const text = normalizeText(message)

  return (
    /^(quelli|quelle|questi|queste|solo|soltanto|di\b|tra questi|fra questi)\b/i.test(text) ||
    /^(includi|includendo|escludi|escludendo|senza)\b/i.test(text)
  )
}

function hasRepairPrefix(message = '') {
  return /\b(non questi|non queste|non quelli|non quelle|sbagliato|correggi|intendevo|volevo dire|invece)\b/i.test(
    normalizeText(message)
  )
}

function stripRepairPrefix(message = '') {
  return compact(
    String(message || '')
      .replace(
        /^.*?\b(non questi|non queste|non quelli|non quelle|sbagliato|correggi|intendevo|volevo dire|invece)\b[,:;\s-]*/i,
        ''
      )
      .replace(/^(quelli|quelle|questi|queste)\s+/i, '')
  )
}

function getDontRenewOverride(message = '') {
  const text = normalizeText(message)

  if (
    /\b(senza|escludi|escludendo|esclusi|escluse|tranne|eccetto)\b.{0,50}\b(non rinnovare|da non rinnovare)\b/i.test(
      text
    ) ||
    /\bnon\s+(includere|includi|considerare|considera)\b.{0,50}\b(non rinnovare|da non rinnovare)\b/i.test(
      text
    )
  ) {
    return false
  }

  if (
    /\b(includi|includendo|inclusi|incluse|compresi|comprese|anche)\b.{0,50}\b(non rinnovare|da non rinnovare)\b/i.test(
      text
    ) ||
    /\b(non rinnovare|da non rinnovare)\b.{0,50}\b(inclusi|incluse|compresi|comprese|anche)\b/i.test(
      text
    )
  ) {
    return true
  }

  return null
}

function findCompoundScopeSplit(message = '') {
  const text = compact(message)

  const match = text.match(
    /^(.+?)\s+((?:solo|soltanto)\b|(?:con|senza)\b|(?:da\s+non\s+rinnovare|non\s+rinnovare)\b|(?:includi|escludi)\b)([\s\S]*)$/i
  )

  if (!match?.[1] || !match?.[2]) return null

  const scopeMessage = buildBareRenewalsEntityServiceListMessage(match[1])
  if (!scopeMessage) return null

  return `${scopeMessage} ${match[2]}${match[3] || ''}`
}

function normalizeServiceListMessage(message = '') {
  const original = compact(message)
  if (!original) return original

  if (/^di\s+\S+/i.test(original)) {
    return `servizi ${original}`
  }

  if (hasAnyQueryAnchor(original)) {
    return original
  }

  const bareMessage = buildBareRenewalsEntityServiceListMessage(original)
  if (bareMessage) return bareMessage

  const compound = findCompoundScopeSplit(original)
  if (compound) return compound

  return original
}

function meaningfulFilters(filters = []) {
  return (Array.isArray(filters) ? filters : []).filter(
    filter => filter?.kind && filter.kind !== 'all'
  )
}

function filterFamily(filter = {}) {
  return FILTER_FAMILIES[filter.kind] || filter.kind
}

function mergeFilters(previousFilters = [], currentFilters = []) {
  const result = meaningfulFilters(previousFilters).map(filter => ({...filter}))

  for (const filter of meaningfulFilters(currentFilters)) {
    const family = filterFamily(filter)
    const next = result.filter(existing => filterFamily(existing) !== family)

    next.push({...filter})
    result.splice(0, result.length, ...next)
  }

  return result.length ? result : [{kind: 'all', label: 'servizi'}]
}

function describeFilters(filters = []) {
  const active = meaningfulFilters(filters)
  if (!active.length) return 'servizi'

  return `servizi ${active
    .map(filter => filter.label)
    .filter(Boolean)
    .join(', ')}`
}

function buildMergedQuery(
  previousQuery = {},
  currentQuery = {},
  message = '',
  {dontRenewOverride = null} = {}
) {
  const previousFilters =
    typeof dontRenewOverride === 'boolean'
      ? (previousQuery.filters || []).filter(filter => filter?.kind !== 'dont-renew')
      : previousQuery.filters
  const filters = mergeFilters(previousFilters, currentQuery.filters)

  return {
    ...previousQuery,
    type: 'service-list-query',
    label: describeFilters(filters),
    filters,
    offset: 0,
    requestedAll: false,
    requestedMore: false,
    requestedPrevious: false,
    requestedFirst: true,
    sourceMessage: compact(message) || previousQuery.sourceMessage || '',
  }
}

function buildReplacementQuery(currentQuery = {}, message = '') {
  const filters = meaningfulFilters(currentQuery.filters)

  return {
    ...currentQuery,
    type: 'service-list-query',
    label: describeFilters(filters),
    filters: filters.length ? filters : [{kind: 'all', label: 'servizi'}],
    offset: 0,
    requestedAll: false,
    requestedMore: false,
    requestedPrevious: false,
    requestedFirst: true,
    sourceMessage: compact(message),
  }
}

function buildClarification(reason, question, previousState = null) {
  return {
    type: 'service-list-plan',
    intent: 'clarification',
    mode: 'clarification',
    confidence: 'low',
    clarification: {
      reason,
      question,
    },
    previousState,
  }
}

function isOnlyContextReference(message = '') {
  const text = normalizeText(message)

  return /^(quelli|quelle|questi|queste|solo questi|solo queste|solo quelli|solo quelle)$/.test(
    text
  )
}

function isContextualDontRenewOnly(message = '') {
  const text = normalizeText(message)

  return /^(solo|soltanto)\s+(?:i\s+|gli\s+)?(?:da\s+)?non\s+rinnovare\b/i.test(text)
}

function getPendingSuggestion(previousState = null) {
  return previousState?.data?.query?.suggestion || previousState?.query?.suggestion || null
}

function isSuggestionAcceptance(message = '') {
  const text = normalizeText(message)
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return /^(si|ok|va bene|procedi|fallo|vai|mostra|mostra pure|mostrali|mostrameli|includili|includili pure)$/.test(
    text
  )
}

export function planServiceListRequest({
  message = '',
  previousState = null,
  settings = {},
  now = new Date(),
} = {}) {
  const originalMessage = compact(message)
  if (!originalMessage || isExplicitSummaryRequest(originalMessage)) return null

  const pendingSuggestion = getPendingSuggestion(previousState)

  if (pendingSuggestion?.kind === 'include-dont-renew' && isSuggestionAcceptance(originalMessage)) {
    const previousQuery = previousState?.query

    if (!previousQuery?.filters?.length) {
      return buildClarification(
        'missing-suggested-query',
        'Non riesco più a ricostruire la ricerca precedente. Puoi ripetere quali servizi vuoi vedere?',
        previousState
      )
    }

    return {
      type: 'service-list-plan',
      intent: 'service-list',
      mode: 'follow-up',
      confidence: 'high',
      sourceMessage: previousQuery.sourceMessage || previousState?.sourceMessage || originalMessage,
      previousQuery: {
        ...previousQuery,
        includeDontRenew: true,
        suggestion: null,
        offset: 0,
        requestedMore: false,
        requestedPrevious: false,
        requestedFirst: true,
      },
      pagination: {
        direction: 'first',
        limit: previousState?.limit || previousQuery.limit || 20,
        offset: 0,
      },
      includeDontRenewOverride: true,
      clarification: null,
    }
  }

  const repair = hasRepairPrefix(originalMessage)
  const parseMessage = repair ? stripRepairPrefix(originalMessage) : originalMessage
  const normalizedMessage = normalizeServiceListMessage(parseMessage)
  const currentQuery = parseServiceListQuery({
    message: normalizedMessage,
    settings,
    now,
  })
  const currentFilters = meaningfulFilters(currentQuery.filters)
  const dontRenewOverride = getDontRenewOverride(originalMessage)
  const explicitListAnchor = hasExplicitListAnchor(originalMessage)
  const explicitScopeAnchor = hasExplicitScopeAnchor(originalMessage)
  const contextualReference = hasContextReference(originalMessage)
  const inferredMessage = normalizedMessage !== parseMessage
  const previousQuery = previousState?.query?.filters?.length
    ? previousState.query
    : previousState?.sourceMessage
      ? parseServiceListQuery({
          message: normalizeServiceListMessage(previousState.sourceMessage),
          settings,
          now,
        })
      : null

  if (isOnlyContextReference(originalMessage)) {
    return buildClarification(
      'ambiguous-reference',
      previousState
        ? 'Cosa vuoi fare con i servizi della lista precedente? Puoi indicare un filtro, chiedere i risultati successivi o richiedere più dettagli.'
        : 'Non ho una lista precedente a cui riferire questa richiesta. Quali servizi vuoi vedere?',
      previousState
    )
  }

  if (!previousState && (contextualReference || isContextualDontRenewOnly(originalMessage))) {
    return buildClarification(
      'context-required',
      isContextualDontRenewOnly(originalMessage)
        ? 'Vuoi vedere tutti i servizi marcati NON RINNOVARE oppure quelli di un cliente o gruppo specifico?'
        : 'Non ho una lista precedente a cui applicare questo filtro. Vuoi usarlo su tutti i servizi o su un cliente/gruppo specifico?',
      null
    )
  }

  if (repair) {
    if (!currentFilters.length) {
      return buildClarification(
        'incomplete-repair',
        'Ho capito che vuoi correggere la richiesta, ma non quale lista o filtro usare al posto del precedente.',
        previousState
      )
    }

    const replacementQuery = buildReplacementQuery(currentQuery, normalizedMessage)

    return {
      type: 'service-list-plan',
      intent: 'service-list',
      mode: 'repair',
      confidence: 'high',
      sourceMessage: normalizedMessage,
      previousQuery: replacementQuery,
      pagination: {
        direction: 'first',
        limit: previousState?.limit || replacementQuery.limit || 20,
        offset: 0,
      },
      includeDontRenewOverride: dontRenewOverride,
      clarification: null,
    }
  }

  const isFollowUp = Boolean(
    previousQuery &&
    (contextualReference ||
      dontRenewOverride !== null ||
      /^di\s+/i.test(originalMessage) ||
      (!explicitListAnchor && currentFilters.length > 0 && !inferredMessage))
  )

  if (isFollowUp) {
    if (!currentFilters.length && dontRenewOverride === null) {
      return buildClarification(
        'ambiguous-filter',
        'Quale filtro vuoi applicare alla lista precedente?',
        previousState
      )
    }

    const mergedQuery = buildMergedQuery(previousQuery, currentQuery, normalizedMessage, {
      dontRenewOverride,
    })

    return {
      type: 'service-list-plan',
      intent: 'service-list',
      mode: 'follow-up',
      confidence: 'high',
      sourceMessage: normalizedMessage,
      previousQuery: mergedQuery,
      pagination: {
        direction: 'first',
        limit: previousState.limit || mergedQuery.limit || 20,
        offset: 0,
      },
      includeDontRenewOverride:
        dontRenewOverride !== null
          ? dontRenewOverride
          : currentFilters.some(filter => filter.kind === 'dont-renew')
            ? true
            : null,
      clarification: null,
    }
  }

  const hasScopeFilter = currentFilters.some(filter => filter.kind === 'customer-or-group')
  const hasAdditionalScopeFilter = hasScopeFilter && currentFilters.length > 1
  const isNewServiceList = Boolean(
    inferredMessage ||
    (explicitListAnchor && currentFilters.length > 0) ||
    (explicitScopeAnchor && hasAdditionalScopeFilter)
  )

  if (!isNewServiceList) return null

  return {
    type: 'service-list-plan',
    intent: 'service-list',
    mode: 'new',
    confidence: 'high',
    sourceMessage: normalizedMessage,
    previousQuery: null,
    pagination: null,
    includeDontRenewOverride: dontRenewOverride,
    clarification: null,
  }
}
