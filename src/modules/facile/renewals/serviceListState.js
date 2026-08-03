import {pickExplicitChatIntent} from './intents.js'
import {parseServiceListQuery} from './serviceQueries.js'
import {planServiceListRequest} from './serviceQueryPlanner.js'
import {parseServiceListReferenceRequest} from './serviceListReferences.js'
import {
  buildServiceListPagination,
  parseServiceListPaginationRequest,
} from './serviceListPagination.js'
import {normalizeSearchText} from '../../../utils/text.js'

export function isDetailsFollowUp(message = '') {
  return /(\bpi[uù] dettagli\b|\bdettagli\b|\bapprofondisci\b|\bdimmi di pi[uù]\b|\bspiegami meglio\b|\bentra nel dettaglio\b)/i.test(
    String(message || '')
  )
}

export function getHistoryContent(item = {}) {
  return String(item?.content || item?.message || item?.text || item?.reply || '').trim()
}

function getHistoryItemData(item = {}) {
  return item?.data || item?.payload || item?.response?.data || item?.result?.data || null
}

function matchesServiceListStateScope(data = {}, scope = {}) {
  if (!data.scope) {
    return true
  }

  return (
    String(data.scope.customerId || '') === String(scope.customerId || '') &&
    String(data.scope.groupId || '') === String(scope.groupId || '') &&
    String(data.scope.serviceId || '') === String(scope.serviceId || '')
  )
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value)

  return Number.isFinite(number) ? number : fallback
}

function findCurrentHistoryMessageIndex(history = [], currentMessage = '') {
  const expectedMessage = normalizeSearchText(currentMessage)

  if (!expectedMessage) {
    return -1
  }

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]
    const role = item?.role
    const content = getHistoryContent(item)

    if (!content || !['user', 'assistant'].includes(role)) {
      continue
    }

    /*
     * Il messaggio corrente può essere escluso soltanto se è
     * l'ultimo turno conversazionale presente nella cronologia.
     */
    if (role !== 'user') {
      return -1
    }

    return normalizeSearchText(content) === expectedMessage ? index : -1
  }

  return -1
}

export function pickPreviousServiceListState(
  history = [],
  scope = {},
  settings = {},
  currentMessage = ''
) {
  const items = Array.isArray(history) ? history : []
  const currentHistoryMessageIndex = findCurrentHistoryMessageIndex(items, currentMessage)

  let state = null

  for (const [index, item] of items.entries()) {
    if (index === currentHistoryMessageIndex) {
      continue
    }

    const role = item?.role
    const content = getHistoryContent(item)

    if (role === 'user') {
      if (!content) {
        continue
      }

      const historyIntent = pickExplicitChatIntent(content, scope)

      if (
        parseServiceListReferenceRequest(content, {
          allowBarePosition: Boolean(state),
        }) ||
        historyIntent === 'service-detail' ||
        (state && isDetailsFollowUp(content))
      ) {
        continue
      }

      const paginationRequest = parseServiceListPaginationRequest(content)

      if (paginationRequest && state) {
        const pagination = buildServiceListPagination(state, paginationRequest)

        if (pagination && !pagination.blockedReason) {
          state = applyServiceListPaginationToState(state, pagination)
        }

        continue
      }

      const listPlan = planServiceListRequest({
        message: content,
        previousState: state,
        settings,
      })

      if (listPlan?.intent === 'service-list') {
        state = buildServiceListStateFromPlan({
          plan: listPlan,
          message: content,
          previousState: state,
          settings,
        })
      }

      continue
    }

    if (role !== 'assistant') {
      continue
    }

    const data = getHistoryItemData(item)

    if (data?.type === 'service-list' && matchesServiceListStateScope(data, scope)) {
      state = buildServiceListStateFromData(data, state?.sourceMessage || null)

      continue
    }

    if (!state || !content) {
      continue
    }

    const suggestion = parseServiceListSuggestion(content)

    if (suggestion) {
      state = {
        ...state,
        query: {
          ...(state.query || {}),
          suggestion,
        },
        data: {
          ...(state.data || {}),
          type: 'service-list',
          query: {
            ...(state.data?.query || state.query || {}),
            suggestion,
          },
        },
      }

      continue
    }

    const textState = parseServiceListTextState(content)

    if (textState) {
      state = {
        ...state,
        ...textState,
        query: {
          ...(state.query || {}),
          offset: textState.offset,
          limit: textState.limit,
        },
      }
    }
  }

  return state
}

function buildServiceListStateFromPlan({
  plan,
  message = '',
  previousState = null,
  settings = {},
} = {}) {
  const sourceMessage = plan?.sourceMessage || message

  let query = null

  if (plan?.previousQuery?.filters?.length) {
    const pagination = plan.pagination || {}

    const limit = toFiniteNumber(
      pagination.limit,
      toFiniteNumber(plan.previousQuery.limit, previousState?.limit || 20)
    )

    const offset = Math.max(toFiniteNumber(pagination.offset, 0), 0)

    query = {
      ...plan.previousQuery,
      limit,
      offset,
      requestedLimit: Boolean(pagination.limit),
      requestedAll: false,
      requestedMore: pagination.direction === 'next',
      requestedPrevious: pagination.direction === 'previous',
      requestedFirst: pagination.direction === 'first',
      sourceMessage: plan.previousQuery.sourceMessage || sourceMessage,
    }
  } else {
    query = parseServiceListQuery({
      message: sourceMessage,
      settings,
    })
  }

  if (typeof plan?.includeDontRenewOverride === 'boolean') {
    query = {
      ...query,
      includeDontRenew: plan.includeDontRenewOverride,
    }
  }

  const offset = toFiniteNumber(query?.offset, 0)

  const limit = toFiniteNumber(query?.limit, previousState?.limit || 20)

  return {
    data: null,
    query,
    sourceMessage: query?.sourceMessage || sourceMessage,
    offset,
    shown: 0,
    limit,
    hasMore: null,
    nextOffset: offset + limit,
    previousOffset: offset > 0 ? Math.max(offset - limit, 0) : null,
  }
}

function buildServiceListStateFromData(data = {}, fallbackSourceMessage = null) {
  const query = data.query || {}
  const offset = toFiniteNumber(query.offset, 0)

  const shown = toFiniteNumber(data.shown, Array.isArray(data.items) ? data.items.length : 0)

  const limit = toFiniteNumber(query.limit, shown || 20)

  const hasMore =
    typeof data.hasMore === 'boolean'
      ? data.hasMore
      : typeof data.truncated === 'boolean'
        ? data.truncated
        : null

  return {
    data,
    query,
    sourceMessage: query.sourceMessage || fallbackSourceMessage,
    offset,
    shown,
    limit,
    hasMore,
    nextOffset: Number.isFinite(data.nextOffset) ? data.nextOffset : offset + shown,
    previousOffset: Number.isFinite(data.previousOffset)
      ? data.previousOffset
      : offset > 0
        ? Math.max(offset - limit, 0)
        : null,
  }
}

function applyServiceListPaginationToState(state, pagination) {
  const limit = toFiniteNumber(pagination.limit, state.limit || 20)

  const offset = Math.max(toFiniteNumber(pagination.offset, 0), 0)

  return {
    ...state,
    data: null,
    query: {
      ...(state.query || {}),
      limit,
      offset,
      requestedLimit: Boolean(pagination.limit),
      requestedAll: false,
      requestedMore: pagination.direction === 'next',
      requestedPrevious: pagination.direction === 'previous',
      requestedFirst: pagination.direction === 'first',
      sourceMessage: state.query?.sourceMessage || pagination.sourceMessage || state.sourceMessage,
    },
    sourceMessage: pagination.sourceMessage || state.sourceMessage,
    offset,
    shown: 0,
    limit,
    hasMore: null,
    nextOffset: offset + limit,
    previousOffset: offset > 0 ? Math.max(offset - limit, 0) : null,
  }
}

function parseServiceListSuggestion(content = '') {
  const text = String(content || '')

  if (!/\bvuoi che li mostr/i.test(text)) {
    return null
  }

  const match = text.match(/\bho (?:pero\s+)?trovato\s+(\d+)\s+servizi?\b[\s\S]*\bnon rinnovare\b/i)

  if (!match?.[1]) {
    return null
  }

  return {
    kind: 'include-dont-renew',
    count: Number(match[1]),
  }
}

function parseServiceListTextState(content = '') {
  const text = String(content || '')

  if (!/\b(?:servizi|risultati)\b/i.test(text)) {
    return null
  }

  const range = text.match(/risultati\s+(\d+)\s*-\s*(\d+)/i)

  if (range) {
    const start = Number(range[1])
    const end = Number(range[2])
    const offset = Math.max(start - 1, 0)
    const shown = Math.max(end - start + 1, 0)

    return {
      offset,
      shown,
      limit: shown || 20,
      hasMore: !/non ci sono altri risultati/i.test(text),
      nextOffset: offset + shown,
      previousOffset: Math.max(offset - (shown || 20), 0),
    }
  }

  const firstPage = text.match(/(?:i primi|le prime)\s+(\d+)/i)

  if (firstPage) {
    const shown = Number(firstPage[1])

    return {
      offset: 0,
      shown,
      limit: shown || 20,
      hasMore: !/non ci sono altri risultati/i.test(text),
      nextOffset: shown,
      previousOffset: 0,
    }
  }

  const examples = text.match(/ho trovato\s+\d+\s+servizi[\s\S]*?ti mostro\s+(\d+)\s+esempi/i)

  if (examples?.[1]) {
    const shown = Number(examples[1])

    return {
      offset: 0,
      shown,
      limit: shown || 20,
      hasMore: !/non ci sono altri risultati/i.test(text),
      nextOffset: shown,
      previousOffset: 0,
    }
  }

  return null
}
