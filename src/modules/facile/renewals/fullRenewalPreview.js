import {createHash} from 'node:crypto'

import {normalizeSearchText} from '../../../utils/text.js'
import {parseServiceListSelector, resolveServiceListReference} from './serviceListReferences.js'
import {
  buildRenewalPreviewPayload,
  getRenewalCustomerSubscriptions,
  loadRenewalExternalChecks,
  resolveRenewalServiceTarget,
  resolveRenewalSubscriptionSelection,
} from './renewalPreview.js'
import {
  buildSupplierRenewalPreviewPayload,
  getSupplierRenewalCandidates,
} from './supplierRenewalPreview.js'

const TOOL_ID = 'renewals.preview-full-service-renewal'
const CONTEXT_TTL_MS = 30 * 60 * 1000
const pendingClarifications = new Map()
const recentTargets = new Map()

const DOMAIN_PATTERN =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\b/i

const FULL_RENEWAL_PATTERN =
  /\b(?:rinnovo\s+(?:completo|totale|complessivo)|rinnova(?:re|mi)?\s+(?:completamente|interamente|tutto)|rinnova(?:re|mi)?\s+(?:sia\s+)?(?:il\s+)?cliente\s+(?:sia\s+)?(?:e|che)\s+(?:il\s+)?fornitore|rinnova(?:re|mi)?\s+(?:sia\s+)?(?:il\s+)?fornitore\s+(?:sia\s+)?(?:e|che)\s+(?:il\s+)?cliente|rinnovo\s+(?:di\s+)?cliente\s+e\s+fornitore|rinnovo\s+(?:di\s+)?fornitore\s+e\s+cliente)\b/i

const PREVIEW_ONLY_PATTERN =
  /\b(?:anteprima|simula|simulazione|proposta|prepara|preparami|calcola|mostra|mostrami|fammi\s+vedere|cosa\s+succederebbe|che\s+succede|cosa\s+comporta)\b/i

const LIST_REQUEST_PATTERN =
  /\b(?:tutti|tutte|elenco|lista|servizi|domini)\b[\s\S]{0,100}\b(?:scadono|in\s+scadenza|da\s+rinnovare|rinnovi\s+imminenti)\b/i

function fingerprintToken(token = '') {
  return createHash('sha256')
    .update(String(token || ''))
    .digest('hex')
    .slice(0, 24)
}

function cleanup(now = Date.now()) {
  for (const [key, pending] of pendingClarifications.entries()) {
    if (!pending || pending.expiresAt <= now) pendingClarifications.delete(key)
  }

  for (const [key, recent] of recentTargets.entries()) {
    if (!recent || recent.expiresAt <= now) recentTargets.delete(key)
  }
}

function rememberTarget(actorToken = '', service = null) {
  if (!service?.id) return

  recentTargets.set(fingerprintToken(actorToken), {
    serviceId: String(service.id),
    expiresAt: Date.now() + CONTEXT_TTL_MS,
  })
}

function getRecentTarget(actorToken = '') {
  cleanup()
  return recentTargets.get(fingerprintToken(actorToken))?.serviceId || null
}

function normalizeComparable(value = '') {
  return normalizeSearchText(value)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[/?#].*$/, '')
    .replace(/[.,!?;:]+$/g, '')
    .trim()
}

function cleanNamedTarget(value = '') {
  const cleaned = String(value || '')
    .replace(/^[\s:,-]+|[\s?.!,;:,-]+$/g, '')
    .replace(/^(?:il|lo|la|i|gli|le|un|una)\s+/i, '')
    .replace(/^(?:servizio|dominio|sito|rinnovo)\s+/i, '')
    .replace(/^(?:di|del|dello|della|per|su|sul)\s+/i, '')
    .trim()

  if (/^(?:ora|adesso|poi|questo|questa|quello|quella|lo stesso|la stessa)$/i.test(cleaned)) {
    return null
  }

  return cleaned || null
}

function extractNamedTarget(message = '') {
  const text = String(message || '').trim()
  const quoted = text.match(/["“”']([^"“”']{2,})["“”']/)

  if (quoted?.[1]) return cleanNamedTarget(quoted[1])

  const domain = text.match(DOMAIN_PATTERN)?.[0]
  if (domain) return normalizeComparable(domain)

  const patterns = [
    /\b(?:rinnova(?:re|mi)?|prepara|preparami|simula|simulami|mostra|mostrami)\b[\s\S]{0,100}\b(?:completamente|interamente|tutto|completo|totale|cliente\s+e\s+fornitore|fornitore\s+e\s+cliente)\b\s*(?:di|del|della|per)?\s+(.+)$/i,
    /\b(?:anteprima|proposta|simulazione)\b[\s\S]{0,80}\b(?:rinnovo\s+completo|cliente\s+e\s+fornitore|fornitore\s+e\s+cliente)\b\s*(?:di|del|della|per)?\s+(.+)$/i,
  ]

  for (const pattern of patterns) {
    const target = cleanNamedTarget(text.match(pattern)?.[1])
    if (target) return target
  }

  return null
}

export function isFullRenewalRequest(message = '') {
  const normalized = normalizeSearchText(message)

  if (!normalized || LIST_REQUEST_PATTERN.test(normalized)) return false

  return FULL_RENEWAL_PATTERN.test(normalized)
}

export function isFullRenewalPreviewOnlyRequest(message = '') {
  const normalized = normalizeSearchText(message)
  return isFullRenewalRequest(normalized) && PREVIEW_ONLY_PATTERN.test(normalized)
}

export function parseFullRenewalBaseRequest(message = '') {
  const text = String(message || '').trim()

  if (!isFullRenewalRequest(text)) return null

  const selector = parseServiceListSelector(text)
  const namedTarget = selector ? null : extractNamedTarget(text)

  return {
    type: 'renewals-full-renewal-request',
    tool: TOOL_ID,
    message: text,
    selector,
    selectorSource: selector ? 'previous-list' : namedTarget ? 'named-target' : 'context',
    namedTarget,
  }
}

export function parseFullRenewalPreviewRequest(message = '') {
  if (!isFullRenewalPreviewOnlyRequest(message)) return null

  const request = parseFullRenewalBaseRequest(message)
  return request
    ? {
        ...request,
        type: 'renewals-full-renewal-preview-request',
      }
    : null
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('it-IT').format(date)
}

function normalizeDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function uniqueMessages(items = []) {
  const map = new Map()

  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue
    const code = String(item.code || '').trim()
    const message = String(item.message || item.title || '').trim()
    const key = `${code}|${message}`
    if (!message || map.has(key)) continue
    map.set(key, {...item, code: code || 'generic', message})
  }

  return [...map.values()]
}

export function getFullRenewalSupplierCandidates(service, customerSubscription) {
  const all = getSupplierRenewalCandidates(service)
  const customerId = String(customerSubscription?.id || '')

  const linked = all.filter(candidate => {
    return String(candidate?.customerSubscription?.id || '') === customerId
  })

  if (linked.length) return linked

  return getRenewalCustomerSubscriptions(service).length === 1 ? all : []
}

function toSupplierCandidateItem(candidate = {}, index = 0) {
  const subscription = candidate?.subscription || {}
  const plan = subscription?.plan || {}

  return {
    id: subscription.id || null,
    ids: subscription.id ? [subscription.id] : [],
    servizio: plan.name || `Sottoscrizione fornitore ${index + 1}`,
    piano: plan.name || null,
    cliente: plan.supplier?.name || null,
    fornitore: plan.supplier?.name || null,
    dominio: subscription.endsOn || null,
  }
}

export function parseFullRenewalClarificationSelector(message = '') {
  const selector = parseServiceListSelector(message)
  if (selector) return selector

  const normalized = normalizeSearchText(message)
  const numeric = normalized.match(/^(?:numero\s+|n\.?\s*)?(\d{1,2})(?:\s*[°º])?$/i)

  if (numeric?.[1] && Number(numeric[1]) > 0) {
    return {kind: 'position', position: Number(numeric[1])}
  }

  return null
}

export function resolveFullRenewalSupplierSelection(message = '', candidates = []) {
  const selector = parseFullRenewalClarificationSelector(message)

  if (!selector) {
    const target = normalizeComparable(message)
    const exact = candidates.filter(candidate => {
      const subscription = candidate?.subscription || {}
      return (
        String(subscription.id || '') === String(message || '').trim() ||
        normalizeComparable(subscription?.plan?.name) === target ||
        normalizeComparable(subscription?.plan?.supplier?.name) === target
      )
    })

    return exact.length === 1 ? {status: 'resolved', candidate: exact[0]} : null
  }

  const items = candidates.map(toSupplierCandidateItem)
  const result = resolveServiceListReference({request: {selector}, items})

  if (result.status !== 'resolved') return {status: result.status, result}

  const id = result.item?.id
  const candidate = candidates.find(item => String(item?.subscription?.id) === String(id))

  return candidate ? {status: 'resolved', candidate} : {status: 'not-found', result}
}

export function buildFullRenewalPreviewPayload({
  service,
  customerSubscription,
  supplierCandidate = null,
  httpCheck = null,
  httpCheckError = null,
  pleskAudit = null,
  pleskAuditError = null,
} = {}) {
  const customerPreview = buildRenewalPreviewPayload({
    service,
    customerSubscription,
    httpCheck,
    httpCheckError,
    pleskAudit,
    pleskAuditError,
  })

  const supplierPreview = buildSupplierRenewalPreviewPayload({
    service,
    supplierSubscription: supplierCandidate?.subscription || null,
    customerSubscription: supplierCandidate?.customerSubscription || customerSubscription || null,
    mode: 'renew-by-plan-duration',
  })

  const blockers = [
    ...(customerPreview.blockers || []),
    ...(supplierPreview.blockers || []),
  ]
  const warnings = [
    ...(customerPreview.warnings || []),
    ...(supplierPreview.warnings || []),
  ]

  if (!supplierCandidate?.subscription?.id) {
    blockers.push({
      code: 'supplier-subscription-required',
      message: 'Il rinnovo completo richiede una sottoscrizione fornitore identificata.',
    })
  }

  const customerProposedEnd = normalizeDate(customerPreview?.customerSubscription?.proposedEndDate)
  const supplierProposedEnd = normalizeDate(supplierPreview?.supplierSubscription?.proposedEndDate)

  if (customerProposedEnd && supplierProposedEnd && supplierProposedEnd < customerProposedEnd) {
    warnings.push({
      code: 'supplier-expiry-before-proposed-customer-expiry',
      message: `Dopo il rinnovo completo, la scadenza fornitore ${formatDate(
        supplierProposedEnd
      )} precederebbe la nuova scadenza cliente ${formatDate(customerProposedEnd)}.`,
    })
  }

  const combinedBlockers = uniqueMessages(blockers)
  const combinedWarnings = uniqueMessages(warnings)

  return {
    type: 'full-renewal-preview',
    previewOnly: true,
    executionAllowed: false,
    status: combinedBlockers.length ? 'blocked' : 'ready',
    service: customerPreview.service,
    customerRenewal: customerPreview,
    supplierRenewal: supplierPreview,
    flags: customerPreview.flags,
    plesk: customerPreview.plesk,
    http: customerPreview.http,
    systemsToCoordinate: uniqueMessages(
      [
        {code: 'crm', message: 'CRM rinnovi'},
        ...(customerPreview.plesk?.connected ? [{code: 'plesk', message: 'Plesk'}] : []),
        {
          code: 'supplier-crm',
          message: supplierPreview.externalSupplier?.name
            ? `sottoscrizione fornitore ${supplierPreview.externalSupplier.name} nel CRM`
            : 'sottoscrizione fornitore nel CRM',
        },
      ]
    ).map(item => item.message),
    checks: [
      ...(customerPreview.checks || []).map(item => ({...item, section: 'customer'})),
      ...(supplierPreview.checks || []).map(item => ({...item, section: 'supplier'})),
    ],
    blockers: combinedBlockers,
    warnings: combinedWarnings,
  }
}

export function buildFullRenewalPreviewReply(
  payload = {},
  {includePreviewDisclaimer = true, includeConfirmationPrompt = false} = {}
) {
  const label = payload?.service?.domain || payload?.service?.name || 'servizio'
  const customer = payload?.customerRenewal?.customerSubscription || {}
  const supplier = payload?.supplierRenewal?.supplierSubscription || {}
  const supplierName = supplier?.plan?.supplier?.name || 'fornitore'
  const lines = [`Rinnovo completo proposto per "${label}".`]

  lines.push('')
  lines.push('Sottoscrizione cliente')
  lines.push(
    `- scadenza: ${formatDate(customer.currentEndDate)} → ${formatDate(customer.proposedEndDate)}`
  )
  if (customer?.plan?.name) {
    lines.push(
      `- piano: ${customer.plan.name}${customer.plan.durationMonths ? ` | ${customer.plan.durationMonths} mesi` : ''}`
    )
  }

  lines.push('')
  lines.push('Sottoscrizione fornitore')
  lines.push(`- fornitore: ${supplierName}`)
  lines.push(
    `- scadenza: ${formatDate(supplier.currentEndDate)} → ${formatDate(supplier.proposedEndDate)}`
  )
  if (supplier?.plan?.name) {
    lines.push(
      `- piano: ${supplier.plan.name}${supplier.plan.durationMonths ? ` | ${supplier.plan.durationMonths} mesi` : ''}`
    )
  }

  lines.push('')
  lines.push(
    payload?.plesk?.connected
      ? `Plesk: verrà aggiornato alla nuova scadenza cliente ${formatDate(customer.proposedEndDate)}.`
      : 'Plesk: non applicabile per questo servizio.'
  )
  lines.push('Al completamento verrà rimosso il flag DA RINNOVARE.')
  lines.push('Nessun ordine o rinnovo verrà eseguito automaticamente nel portale/API del fornitore.')

  if (payload.blockers?.length) {
    lines.push('')
    lines.push(`Blocchi: ${payload.blockers.map(item => item.message).join(' ')}`)
  }

  if (payload.warnings?.length) {
    lines.push('')
    lines.push(`Avvisi: ${payload.warnings.map(item => item.message).join(' ')}`)
  }

  if (includeConfirmationPrompt && payload.status === 'ready') {
    lines.push('')
    lines.push('Confermi?')
  } else if (includePreviewDisclaimer) {
    lines.push('')
    lines.push('Questa è solo un’anteprima: nessuna modifica è stata eseguita.')
  }

  return lines.join('\n')
}

export function buildFullRenewalServiceClarification(candidates = []) {
  const lines = ['Ho trovato più servizi compatibili. Per quale vuoi preparare il rinnovo completo?']

  candidates.slice(0, 10).forEach((service, index) => {
    lines.push(
      `${index + 1}. ${service?.name || '—'} | dominio ${
        service?.domains_id?.name || service?.domain?.name || '—'
      } | cliente ${service?.customer?.name || '—'}`
    )
  })

  return lines.join('\n')
}

export function buildFullRenewalCustomerClarification(service, subscriptions = []) {
  const label = service?.domains_id?.name || service?.name || 'servizio'
  const lines = [
    `Il servizio "${label}" ha più sottoscrizioni cliente. Quale vuoi includere nel rinnovo completo?`,
  ]

  subscriptions.forEach((subscription, index) => {
    lines.push(
      `${index + 1}. ${subscription?.plan?.name || 'Piano non indicato'} | scadenza ${formatDate(
        subscription?.endsOn
      )} | ID ${subscription?.id || '—'}`
    )
  })

  return lines.join('\n')
}

export function buildFullRenewalSupplierClarification(service, candidates = []) {
  const label = service?.domains_id?.name || service?.name || 'servizio'
  const lines = [
    `Il servizio "${label}" ha più sottoscrizioni fornitore compatibili. Quale vuoi includere nel rinnovo completo?`,
  ]

  candidates.forEach((candidate, index) => {
    const subscription = candidate?.subscription || {}
    lines.push(
      `${index + 1}. ${subscription?.plan?.supplier?.name || 'Fornitore non indicato'} | piano ${
        subscription?.plan?.name || '—'
      } | scadenza ${formatDate(subscription?.endsOn)} | ID ${subscription?.id || '—'}`
    )
  })

  return lines.join('\n')
}

function storeClarification(actorToken = '', payload = {}) {
  pendingClarifications.set(fingerprintToken(actorToken), {
    ...payload,
    expiresAt: Date.now() + CONTEXT_TTL_MS,
  })
}

export function hasPendingFullRenewalPreviewClarification({actorToken = ''} = {}) {
  cleanup()
  return pendingClarifications.has(fingerprintToken(actorToken))
}

export async function buildFullRenewalPreviewForSelection({
  service,
  customerSubscription,
  supplierCandidate,
  checksLoader = loadRenewalExternalChecks,
} = {}) {
  const checks = await checksLoader(service)

  return buildFullRenewalPreviewPayload({
    service,
    customerSubscription,
    supplierCandidate,
    ...checks,
  })
}

async function continueWithCustomer({
  service,
  customerSubscription,
  actorToken,
  checksLoader,
}) {
  const supplierCandidates = getFullRenewalSupplierCandidates(service, customerSubscription)

  if (!supplierCandidates.length) {
    const preview = await buildFullRenewalPreviewForSelection({
      service,
      customerSubscription,
      supplierCandidate: null,
      checksLoader,
    })

    rememberTarget(actorToken, service)

    return {
      ok: true,
      intent: 'renewal-preview',
      source: 'tool-fast',
      reply: buildFullRenewalPreviewReply(preview),
      data: preview,
      meta: {
        moduleId: 'facile.renewals',
        source: 'tool-fast',
        intent: 'renewal-preview',
        tool: TOOL_ID,
      },
    }
  }

  if (supplierCandidates.length > 1) {
    storeClarification(actorToken, {
      kind: 'supplier-subscription',
      serviceId: String(service.id),
      customerSubscriptionId: String(customerSubscription.id),
      supplierSubscriptionIds: supplierCandidates.map(candidate =>
        String(candidate?.subscription?.id)
      ),
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildFullRenewalSupplierClarification(service, supplierCandidates),
      data: {type: 'clarification', reason: 'full-renewal-supplier-subscription-ambiguous'},
      meta: {
        moduleId: 'facile.renewals',
        source: 'tool-fast',
        intent: 'clarification',
        tool: TOOL_ID,
      },
    }
  }

  const preview = await buildFullRenewalPreviewForSelection({
    service,
    customerSubscription,
    supplierCandidate: supplierCandidates[0],
    checksLoader,
  })

  rememberTarget(actorToken, service)

  return {
    ok: true,
    intent: 'renewal-preview',
    source: 'tool-fast',
    reply: buildFullRenewalPreviewReply(preview),
    data: preview,
    meta: {
      moduleId: 'facile.renewals',
      source: 'tool-fast',
      intent: 'renewal-preview',
      tool: TOOL_ID,
    },
  }
}

async function continueWithService({service, actorToken, checksLoader}) {
  const customerSubscriptions = getRenewalCustomerSubscriptions(service)

  if (!customerSubscriptions.length) {
    const preview = await buildFullRenewalPreviewForSelection({
      service,
      customerSubscription: null,
      supplierCandidate: null,
      checksLoader,
    })

    return {
      ok: true,
      intent: 'renewal-preview',
      source: 'tool-fast',
      reply: buildFullRenewalPreviewReply(preview),
      data: preview,
      meta: {
        moduleId: 'facile.renewals',
        source: 'tool-fast',
        intent: 'renewal-preview',
        tool: TOOL_ID,
      },
    }
  }

  if (customerSubscriptions.length > 1) {
    storeClarification(actorToken, {
      kind: 'customer-subscription',
      serviceId: String(service.id),
      customerSubscriptionIds: customerSubscriptions.map(item => String(item.id)),
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildFullRenewalCustomerClarification(service, customerSubscriptions),
      data: {type: 'clarification', reason: 'full-renewal-customer-subscription-ambiguous'},
      meta: {
        moduleId: 'facile.renewals',
        source: 'tool-fast',
        intent: 'clarification',
        tool: TOOL_ID,
      },
    }
  }

  return continueWithCustomer({
    service,
    customerSubscription: customerSubscriptions[0],
    actorToken,
    checksLoader,
  })
}

export async function handleFullRenewalPreviewRequest({
  request,
  services = [],
  settings = {},
  history = [],
  scope = {},
  actorToken = '',
  recentServiceId = null,
  checksLoader = loadRenewalExternalChecks,
} = {}) {
  cleanup()

  const resolution = resolveRenewalServiceTarget({
    request,
    services,
    settings,
    history,
    scope,
    actorToken,
    recentServiceId: recentServiceId || getRecentTarget(actorToken),
  })

  if (resolution.status === 'ambiguous') {
    storeClarification(actorToken, {
      kind: 'service',
      serviceIds: resolution.candidates.map(item => String(item?.id)).filter(Boolean),
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildFullRenewalServiceClarification(resolution.candidates),
      data: {type: 'clarification', reason: 'full-renewal-service-ambiguous'},
      meta: {
        moduleId: 'facile.renewals',
        source: 'tool-fast',
        intent: 'clarification',
        tool: TOOL_ID,
      },
    }
  }

  if (resolution.status !== 'resolved') {
    const reply =
      resolution.status === 'context-required'
        ? 'Indica quale servizio o dominio vuoi rinnovare completamente, oppure usa un riferimento alla lista precedente.'
        : `Non ho trovato un servizio corrispondente a "${request?.namedTarget || request?.message || ''}".`

    return {
      ok: true,
      intent: 'action-error',
      source: 'tool-fast',
      reply,
      data: {
        type: 'action-error',
        error: {code: `full-renewal-${resolution.status || 'not-found'}`},
      },
      meta: {
        moduleId: 'facile.renewals',
        source: 'tool-fast',
        intent: 'action-error',
        tool: TOOL_ID,
      },
    }
  }

  return continueWithService({
    service: resolution.service,
    actorToken,
    checksLoader,
  })
}

export async function handlePendingFullRenewalPreviewClarification({
  message = '',
  services = [],
  actorToken = '',
  checksLoader = loadRenewalExternalChecks,
} = {}) {
  cleanup()

  const key = fingerprintToken(actorToken)
  const pending = pendingClarifications.get(key)
  if (!pending) return null

  const service = services.find(item => String(item?.id) === String(pending.serviceId))

  if (pending.kind === 'service') {
    const candidates = services.filter(item => pending.serviceIds.includes(String(item?.id)))
    const selector = parseFullRenewalClarificationSelector(message)
    const items = candidates.map((item, index) => ({
      id: item.id,
      ids: [item.id],
      servizio: item.name || `Servizio ${index + 1}`,
      dominio: item?.domains_id?.name || item?.domain?.name || null,
      cliente: item?.customer?.name || null,
    }))
    const resolved = selector
      ? resolveServiceListReference({request: {selector}, items})
      : null
    const selected =
      resolved?.status === 'resolved'
        ? candidates.find(item => String(item.id) === String(resolved.item?.id))
        : candidates.find(item => normalizeComparable(item?.name) === normalizeComparable(message))

    if (!selected) {
      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: buildFullRenewalServiceClarification(candidates),
        data: {type: 'clarification', reason: 'full-renewal-service-selection-invalid'},
        meta: {moduleId: 'facile.renewals', source: 'tool-fast', intent: 'clarification', tool: TOOL_ID},
      }
    }

    pendingClarifications.delete(key)
    return continueWithService({service: selected, actorToken, checksLoader})
  }

  if (!service) {
    pendingClarifications.delete(key)
    return null
  }

  if (pending.kind === 'customer-subscription') {
    const subscriptions = getRenewalCustomerSubscriptions(service).filter(item =>
      pending.customerSubscriptionIds.includes(String(item?.id))
    )
    const resolved = resolveRenewalSubscriptionSelection(message, subscriptions)

    if (resolved?.status !== 'resolved') {
      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: buildFullRenewalCustomerClarification(service, subscriptions),
        data: {type: 'clarification', reason: 'full-renewal-customer-selection-invalid'},
        meta: {moduleId: 'facile.renewals', source: 'tool-fast', intent: 'clarification', tool: TOOL_ID},
      }
    }

    pendingClarifications.delete(key)
    return continueWithCustomer({
      service,
      customerSubscription: resolved.subscription,
      actorToken,
      checksLoader,
    })
  }

  if (pending.kind === 'supplier-subscription') {
    const customerSubscription = getRenewalCustomerSubscriptions(service).find(
      item => String(item?.id) === String(pending.customerSubscriptionId)
    )
    const candidates = getFullRenewalSupplierCandidates(service, customerSubscription).filter(item =>
      pending.supplierSubscriptionIds.includes(String(item?.subscription?.id))
    )
    const resolved = resolveFullRenewalSupplierSelection(message, candidates)

    if (resolved?.status !== 'resolved') {
      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: buildFullRenewalSupplierClarification(service, candidates),
        data: {type: 'clarification', reason: 'full-renewal-supplier-selection-invalid'},
        meta: {moduleId: 'facile.renewals', source: 'tool-fast', intent: 'clarification', tool: TOOL_ID},
      }
    }

    pendingClarifications.delete(key)
    const preview = await buildFullRenewalPreviewForSelection({
      service,
      customerSubscription,
      supplierCandidate: resolved.candidate,
      checksLoader,
    })
    rememberTarget(actorToken, service)

    return {
      ok: true,
      intent: 'renewal-preview',
      source: 'tool-fast',
      reply: buildFullRenewalPreviewReply(preview),
      data: preview,
      meta: {moduleId: 'facile.renewals', source: 'tool-fast', intent: 'renewal-preview', tool: TOOL_ID},
    }
  }

  pendingClarifications.delete(key)
  return null
}
