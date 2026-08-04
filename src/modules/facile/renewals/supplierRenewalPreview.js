import {createHash} from 'node:crypto'

import {normalizeSearchText} from '../../../utils/text.js'
import {parseServiceListSelector, resolveServiceListReference} from './serviceListReferences.js'
import {
  addMonthsPreservingDay,
  getRenewalCustomerSubscriptions,
  resolveRenewalServiceTarget,
} from './renewalPreview.js'

const TOOL_ID = 'renewals.preview-supplier-subscription-renewal'
const CONTEXT_TTL_MS = 30 * 60 * 1000
const pendingClarifications = new Map()
const recentTargets = new Map()

const DOMAIN_PATTERN =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\b/i

const SUPPLIER_TERM_PATTERN =
  /\b(?:sottoscrizione\s+)?(?:del\s+|della\s+|di\s+)?(?:fornitore|supplier|provider)\b/i

const SUPPLIER_RENEWAL_REQUEST_PATTERN =
  /\b(?:rinnova|rinnovami|rinnovare|prepara|preparami|simula|simulami|anteprima|proposta|calcola|mostra|mostrami|fammi)\b[\s\S]{0,100}\b(?:rinnovo|sottoscrizione|scadenza)\b[\s\S]{0,80}\b(?:fornitore|supplier|provider)\b|\b(?:rinnovo|sottoscrizione|scadenza)\b[\s\S]{0,60}\b(?:fornitore|supplier|provider)\b[\s\S]{0,80}\b(?:rinnova|rinnovare|anteprima|simula|prepara|proposta)\b/i

const ALIGN_SUPPLIER_EXPIRY_PATTERN =
  /\b(?:allinea|allineare|copia|copiare|porta|portare|imposta|impostare|usa|usare|sincronizza|sincronizzare)\b[\s\S]{0,100}\bscadenz[ae]\b[\s\S]{0,40}\b(?:fornitore|supplier|provider)\b[\s\S]{0,100}\bscadenz[ae]\b[\s\S]{0,40}\bcliente\b|\bscadenz[ae]\b[\s\S]{0,40}\b(?:fornitore|supplier|provider)\b[\s\S]{0,100}\b(?:uguale|come|alla|con)\b[\s\S]{0,40}\bscadenz[ae]\b[\s\S]{0,40}\bcliente\b/i

const LIST_REQUEST_PATTERN =
  /\b(?:tutti|tutte|elenco|lista|servizi|domini|fornitori)\b[\s\S]{0,100}\b(?:scadono|in\s+scadenza|da\s+rinnovare|rinnovi\s+imminenti)\b/i

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
    .replace(/^(?:servizio|dominio|sito)\s+/i, '')
    .replace(/^(?:di|del|dello|della|per|su|sul)\s+/i, '')
    .trim()

  if (
    /^(?:ora|adesso|poi|quindi|allora|questo|questa|quello|quella|lo stesso|la stessa)$/i.test(
      cleaned
    )
  ) {
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
    /\b(?:rinnova|rinnovami|prepara|preparami|simula|simulami|mostra|mostrami)\b[\s\S]{0,80}\b(?:sottoscrizione|rinnovo|scadenza)\b[\s\S]{0,40}\b(?:fornitore|supplier|provider)\b\s*(?:di|del|della|per)?\s+(.+)$/i,
    /\b(?:anteprima|proposta|simulazione)\b[\s\S]{0,60}\b(?:rinnovo|sottoscrizione)\b[\s\S]{0,40}\b(?:fornitore|supplier|provider)\b\s*(?:di|del|della|per)?\s+(.+)$/i,
    /\b(?:allinea|copia|porta|imposta|usa|sincronizza)\b[\s\S]{0,100}\bscadenz[ae]\b[\s\S]{0,40}\b(?:fornitore|supplier|provider)\b[\s\S]{0,100}\bcliente\b\s*(?:di|del|della|per)?\s+(.+)$/i,
  ]

  for (const pattern of patterns) {
    const target = cleanNamedTarget(text.match(pattern)?.[1])
    if (target) return target
  }

  return null
}

function parseMode(message = '') {
  return ALIGN_SUPPLIER_EXPIRY_PATTERN.test(normalizeSearchText(message))
    ? 'align-customer-expiry'
    : 'renew-by-plan-duration'
}

export function isSupplierRenewalRequest(message = '') {
  const normalized = normalizeSearchText(message)

  if (!normalized || LIST_REQUEST_PATTERN.test(normalized)) return false

  return (
    (SUPPLIER_TERM_PATTERN.test(normalized) &&
      SUPPLIER_RENEWAL_REQUEST_PATTERN.test(normalized)) ||
    ALIGN_SUPPLIER_EXPIRY_PATTERN.test(normalized)
  )
}

export function parseSupplierRenewalPreviewRequest(message = '') {
  const text = String(message || '').trim()

  if (!isSupplierRenewalRequest(text)) return null

  const selector = parseServiceListSelector(text)
  const namedTarget = selector ? null : extractNamedTarget(text)

  return {
    type: 'renewals-supplier-renewal-preview-request',
    tool: TOOL_ID,
    message: text,
    mode: parseMode(text),
    selector,
    selectorSource: selector ? 'previous-list' : namedTarget ? 'named-target' : 'context',
    namedTarget,
  }
}

function getNestedSupplierSubscriptions(customerSubscription = {}) {
  const raw = [
    ...(customerSubscription?.suppliersSubscriptions || []),
    ...(customerSubscription?.supplierSubscriptions || []),
    ...(customerSubscription?.suppliers_subscriptions || []),
    ...(customerSubscription?.suppliersSubscriptionsChildren || []),
    ...(customerSubscription?.suppliers_subscriptions_children || []),
  ]

  return raw
    .map(item => item?.related_subscriptions_id || item)
    .filter(Boolean)
}

export function getSupplierRenewalCandidates(service = {}) {
  const candidates = new Map()
  const customerSubscriptions = getRenewalCustomerSubscriptions(service)

  for (const customerSubscription of customerSubscriptions) {
    for (const supplierSubscription of getNestedSupplierSubscriptions(customerSubscription)) {
      const id = String(supplierSubscription?.id || '')
      if (!id || candidates.has(id)) continue

      candidates.set(id, {
        subscription: supplierSubscription,
        customerSubscription,
      })
    }
  }

  for (const supplierSubscription of service?.subscriptions || []) {
    if (supplierSubscription?.isSupplier !== true) continue

    const id = String(supplierSubscription?.id || '')
    if (!id || candidates.has(id)) continue

    candidates.set(id, {
      subscription: supplierSubscription,
      customerSubscription: customerSubscriptions.length === 1 ? customerSubscriptions[0] : null,
    })
  }

  return [...candidates.values()]
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

function toIsoDate(value) {
  const date = normalizeDate(value)
  if (!date) return null

  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T12:00:00`
}

function mapPlan(plan = null) {
  if (!plan) return null

  return {
    id: plan.id || null,
    name: plan.name || null,
    description: plan.description || null,
    durationMonths: Number.isFinite(Number(plan.duration)) ? Number(plan.duration) : null,
    supplier: plan.supplier
      ? {
          id: plan.supplier.id || null,
          name: plan.supplier.name || null,
        }
      : null,
    priceFinal: plan.priceFinal ?? null,
    priceList: plan.priceList ?? null,
    priceListStandard: plan.priceListStandard ?? null,
    missingPrice: plan.missingPrice === true,
  }
}

function mapAddon(addon = {}) {
  return {
    id: addon.addonId || addon.id || null,
    name: addon.name || addon?.plan?.name || null,
    priceFinal: addon.priceFinal ?? addon?.plan?.priceFinal ?? null,
    missingPrice: addon.missingPrice === true || addon?.plan?.missingPrice === true,
  }
}

export function buildSupplierRenewalPreviewPayload({
  service,
  supplierSubscription,
  customerSubscription = null,
  mode = 'renew-by-plan-duration',
} = {}) {
  const blockers = []
  const warnings = []
  const checks = []

  const currentEndDate = normalizeDate(supplierSubscription?.endsOn)
  const customerEndDate = normalizeDate(customerSubscription?.endsOn)
  const durationMonths = Number(supplierSubscription?.plan?.duration)
  const proposedEndDate =
    mode === 'align-customer-expiry'
      ? customerEndDate
      : addMonthsPreservingDay(currentEndDate, durationMonths)

  if (!supplierSubscription?.id) {
    blockers.push({
      code: 'supplier-subscription-missing',
      message: 'Sottoscrizione fornitore mancante.',
    })
  }

  if (!currentEndDate) {
    blockers.push({
      code: 'supplier-expiry-missing',
      message: 'Scadenza fornitore mancante o non valida.',
    })
  }

  if (!supplierSubscription?.plan?.id) {
    const destination = mode === 'renew-by-plan-duration' ? blockers : warnings
    destination.push({
      code: 'supplier-plan-missing',
      message: 'Piano della sottoscrizione fornitore mancante.',
    })
  }

  if (
    mode === 'renew-by-plan-duration' &&
    (!Number.isFinite(durationMonths) || durationMonths <= 0)
  ) {
    blockers.push({
      code: 'supplier-plan-duration-missing',
      message: 'Durata del piano fornitore mancante o non valida.',
    })
  }

  if (mode === 'align-customer-expiry' && !customerSubscription?.id) {
    blockers.push({
      code: 'customer-subscription-missing',
      message: 'Non è possibile individuare la sottoscrizione cliente da usare per l’allineamento.',
    })
  }

  if (mode === 'align-customer-expiry' && !customerEndDate) {
    blockers.push({
      code: 'customer-expiry-missing',
      message: 'La sottoscrizione cliente non ha una scadenza valida da copiare.',
    })
  }

  if (service?.dontRenew === true || service?.dont_renew === true) {
    blockers.push({
      code: 'dont-renew-active',
      message: 'Il servizio è marcato NON RINNOVARE.',
    })
  }

  if (service?.toTransfer || service?.to_transfer) {
    warnings.push({
      code: 'transfer-target-active',
      message: 'Il servizio è marcato DA TRASFERIRE: verifica se il fornitore attuale deve davvero essere rinnovato.',
    })
  }

  if (supplierSubscription?.plan?.missingPrice === true) {
    warnings.push({
      code: 'supplier-plan-price-missing',
      message: `Il prezzo del piano fornitore ${supplierSubscription?.plan?.name || '—'} non è disponibile.`,
    })
  }

  for (const addon of supplierSubscription?.addons || []) {
    if (addon?.missingPrice === true || addon?.plan?.missingPrice === true) {
      warnings.push({
        code: 'supplier-addon-price-missing',
        message: `Il prezzo dell’add-on fornitore ${addon?.name || addon?.plan?.name || addon?.id || '—'} non è disponibile.`,
      })
    }
  }

  if (currentEndDate && proposedEndDate) {
    if (proposedEndDate < currentEndDate) {
      blockers.push({
        code: 'supplier-expiry-would-decrease',
        message: `L’operazione ridurrebbe la scadenza fornitore da ${formatDate(currentEndDate)} a ${formatDate(proposedEndDate)}.`,
      })
    } else if (proposedEndDate.getTime() === currentEndDate.getTime()) {
      warnings.push({
        code: 'supplier-expiry-already-aligned',
        message: 'La scadenza fornitore è già uguale alla data proposta.',
      })
    }
  }

  if (
    mode === 'renew-by-plan-duration' &&
    proposedEndDate &&
    customerEndDate &&
    proposedEndDate < customerEndDate
  ) {
    warnings.push({
      code: 'supplier-expiry-before-customer-expiry',
      message: `Anche dopo il rinnovo, la scadenza fornitore ${formatDate(proposedEndDate)} precederebbe la scadenza cliente ${formatDate(customerEndDate)}.`,
    })
  }

  if (!customerSubscription?.id) {
    warnings.push({
      code: 'linked-customer-subscription-missing',
      message: 'Non è stata individuata con certezza una sottoscrizione cliente collegata.',
    })
  }

  checks.push(
    {
      code: 'supplier-subscription',
      status: supplierSubscription?.id ? 'ok' : 'error',
      label: 'Sottoscrizione fornitore',
    },
    {
      code: 'supplier-expiry',
      status: currentEndDate ? 'ok' : 'error',
      label: 'Scadenza fornitore',
    },
    {
      code: 'supplier-plan-duration',
      status:
        mode === 'align-customer-expiry'
          ? 'not-applicable'
          : Number.isFinite(durationMonths) && durationMonths > 0
            ? 'ok'
            : 'error',
      label: 'Durata piano fornitore',
    },
    {
      code: 'customer-expiry',
      status:
        mode === 'align-customer-expiry'
          ? customerEndDate
            ? 'ok'
            : 'error'
          : customerEndDate
            ? 'ok'
            : 'warning',
      label: 'Scadenza cliente',
    },
    {
      code: 'dont-renew',
      status: service?.dontRenew === true || service?.dont_renew === true ? 'error' : 'ok',
      label: 'Flag NON RINNOVARE',
    }
  )

  const supplierName = supplierSubscription?.plan?.supplier?.name || null

  return {
    type: 'supplier-renewal-preview',
    previewOnly: true,
    executionAllowed: false,
    mode,
    status: blockers.length ? 'blocked' : 'ready',
    service: {
      id: service?.id || null,
      name: service?.name || null,
      domain: service?.domains_id?.name || service?.domain?.name || null,
      customer: service?.customer
        ? {
            id: service.customer.id || null,
            name: service.customer.name || null,
          }
        : null,
      group: service?.customer?.group
        ? {
            id: service.customer.group.id || null,
            name: service.customer.group.name || null,
          }
        : null,
    },
    supplierSubscription: {
      id: supplierSubscription?.id || null,
      startsOn: supplierSubscription?.startsOn || null,
      currentEndDate: supplierSubscription?.endsOn || null,
      proposedEndDate: proposedEndDate ? toIsoDate(proposedEndDate) : null,
      plan: mapPlan(supplierSubscription?.plan),
      addons: (supplierSubscription?.addons || []).map(mapAddon),
    },
    customerSubscription: customerSubscription
      ? {
          id: customerSubscription.id || null,
          startsOn: customerSubscription.startsOn || null,
          endsOn: customerSubscription.endsOn || null,
          plan: mapPlan(customerSubscription.plan),
        }
      : null,
    flags: {
      dontRenew: service?.dontRenew === true || service?.dont_renew === true,
      toTransfer: service?.toTransfer || service?.to_transfer || null,
      authCodeSet: Boolean(service?.authCode || service?.auth_code),
    },
    externalSupplier: {
      id: supplierSubscription?.plan?.supplier?.id || null,
      name: supplierName,
      automaticExecutionAvailable: false,
    },
    systemsToCoordinate: ['CRM rinnovi', supplierName ? `fornitore ${supplierName}` : 'fornitore'],
    checks,
    blockers,
    warnings,
  }
}

export function buildSupplierRenewalPreviewReply(
  payload = {},
  {includePreviewDisclaimer = true} = {}
) {
  const label = payload?.service?.domain || payload?.service?.name || 'servizio'
  const supplier = payload?.supplierSubscription || {}
  const supplierName = supplier?.plan?.supplier?.name || 'fornitore'
  const lines = [
    payload.mode === 'align-customer-expiry'
      ? `Anteprima allineamento scadenza fornitore per "${label}".`
      : `Anteprima rinnovo sottoscrizione fornitore per "${label}".`,
  ]

  lines.push(
    `Fornitore: ${supplierName}${supplier?.plan?.name ? ` | piano ${supplier.plan.name}` : ''}.`
  )

  lines.push(
    `Scadenza fornitore: ${formatDate(supplier.currentEndDate)} → ${formatDate(
      supplier.proposedEndDate
    )}.`
  )

  if (payload.mode === 'renew-by-plan-duration' && supplier?.plan?.durationMonths) {
    lines.push(`Durata del piano fornitore: ${supplier.plan.durationMonths} mesi.`)
  }

  if (payload.customerSubscription) {
    lines.push(
      `Scadenza cliente di riferimento: ${formatDate(payload.customerSubscription.endsOn)}${
        payload.customerSubscription.plan?.name
          ? ` | piano ${payload.customerSubscription.plan.name}`
          : ''
      }.`
    )
  }

  if (supplier.addons?.length) {
    lines.push(`Add-on fornitore: ${supplier.addons.map(item => item.name || item.id).join(', ')}.`)
  }

  if (payload.blockers?.length) {
    lines.push(`Blocchi: ${payload.blockers.map(item => item.message).join(' ')}`)
  }

  if (payload.warnings?.length) {
    lines.push(`Avvisi: ${payload.warnings.map(item => item.message).join(' ')}`)
  }

  if (includePreviewDisclaimer) {
    lines.push(
      'Questa è solo un’anteprima: nessuna scadenza è stata modificata e nessun rinnovo è stato eseguito presso il fornitore.'
    )
  }

  return lines.join('\n')
}

function toCandidateItem(candidate = {}, index = 0) {
  const subscription = candidate.subscription || {}
  const customerSubscription = candidate.customerSubscription || null

  return {
    id: subscription.id || null,
    ids: subscription.id ? [subscription.id] : [],
    servizio: subscription?.plan?.name || `Sottoscrizione fornitore ${index + 1}`,
    dominio: subscription?.plan?.supplier?.name || null,
    cliente: customerSubscription?.plan?.name || null,
    gruppo: subscription?.endsOn || null,
    piano: subscription?.plan?.name || null,
  }
}

function buildServiceClarification(candidates = []) {
  const lines = ['Ho trovato più servizi compatibili. Per quale vuoi preparare il rinnovo fornitore?']

  candidates.slice(0, 20).forEach((service, index) => {
    const domain = service?.domains_id?.name || service?.domain?.name || '—'
    const customer = service?.customer?.name || '—'
    lines.push(`${index + 1}. ${service?.name || domain} | dominio ${domain} | cliente ${customer}`)
  })

  return lines.join('\n')
}

function buildSupplierSubscriptionClarification(service, candidates = []) {
  const label = service?.domains_id?.name || service?.domain?.name || service?.name || service?.id
  const lines = [
    `Il servizio "${label}" ha più sottoscrizioni fornitore. Quale vuoi usare?`,
  ]

  candidates.forEach((candidate, index) => {
    const subscription = candidate.subscription || {}
    const supplier = subscription?.plan?.supplier?.name || '—'
    const customerPlan = candidate.customerSubscription?.plan?.name || '—'

    lines.push(
      `${index + 1}. ${supplier} | piano ${subscription?.plan?.name || '—'} | scadenza ${formatDate(
        subscription?.endsOn
      )} | sottoscrizione cliente ${customerPlan} | ID ${subscription?.id || '—'}`
    )
  })

  return lines.join('\n')
}

function parseClarificationSelector(message = '') {
  const selector = parseServiceListSelector(message)
  if (selector) return selector

  const numeric = normalizeSearchText(message).match(/^(?:numero\s+|n\.?\s*)?(\d{1,2})(?:\s*[°º])?$/i)

  return numeric?.[1] && Number(numeric[1]) > 0
    ? {kind: 'position', position: Number(numeric[1])}
    : null
}

function resolveSupplierCandidate(message = '', candidates = []) {
  const selector = parseClarificationSelector(message)

  if (selector) {
    const result = resolveServiceListReference({
      request: {selector},
      items: candidates.map(toCandidateItem),
    })

    if (result.status !== 'resolved') return {status: result.status}

    const candidate = candidates.find(
      item => String(item?.subscription?.id) === String(result.item?.id)
    )

    return candidate ? {status: 'resolved', candidate} : {status: 'not-found'}
  }

  const target = normalizeComparable(message)
  const exact = candidates.filter(candidate => {
    const subscription = candidate.subscription || {}

    return [
      subscription.id,
      subscription?.plan?.name,
      subscription?.plan?.supplier?.name,
      candidate.customerSubscription?.plan?.name,
    ].some(value => normalizeComparable(value) === target)
  })

  if (exact.length === 1) return {status: 'resolved', candidate: exact[0]}

  const contains = candidates.filter(candidate => {
    const subscription = candidate.subscription || {}

    return [
      subscription?.plan?.name,
      subscription?.plan?.supplier?.name,
      candidate.customerSubscription?.plan?.name,
    ].some(value => normalizeComparable(value).includes(target))
  })

  return contains.length === 1
    ? {status: 'resolved', candidate: contains[0]}
    : {status: contains.length > 1 ? 'ambiguous' : 'not-found'}
}

function storeClarification(actorToken = '', payload = {}) {
  pendingClarifications.set(fingerprintToken(actorToken), {
    ...payload,
    expiresAt: Date.now() + CONTEXT_TTL_MS,
  })
}

export function hasPendingSupplierRenewalPreviewClarification({actorToken = ''} = {}) {
  cleanup()
  return pendingClarifications.has(fingerprintToken(actorToken))
}

async function buildPreviewForCandidate({service, candidate, mode, actorToken}) {
  const payload = buildSupplierRenewalPreviewPayload({
    service,
    supplierSubscription: candidate?.subscription || null,
    customerSubscription: candidate?.customerSubscription || null,
    mode,
  })

  rememberTarget(actorToken, service)

  return {
    ok: true,
    intent: 'supplier-renewal-preview',
    source: 'tool-fast',
    reply: buildSupplierRenewalPreviewReply(payload),
    data: payload,
    meta: {
      moduleId: 'facile.renewals',
      source: 'tool-fast',
      intent: 'supplier-renewal-preview',
      tool: TOOL_ID,
      previewOnly: true,
    },
  }
}

async function continueWithService({service, mode, actorToken}) {
  const candidates = getSupplierRenewalCandidates(service)

  if (!candidates.length) {
    return buildPreviewForCandidate({service, candidate: null, mode, actorToken})
  }

  if (candidates.length > 1) {
    storeClarification(actorToken, {
      kind: 'supplier-subscription',
      serviceId: String(service.id),
      supplierSubscriptionIds: candidates.map(item => String(item.subscription.id)),
      mode,
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildSupplierSubscriptionClarification(service, candidates),
      data: {
        type: 'clarification',
        reason: 'supplier-renewal-preview-subscription-ambiguous',
        serviceId: service.id,
      },
      meta: {
        moduleId: 'facile.renewals',
        source: 'tool-fast',
        intent: 'clarification',
        tool: TOOL_ID,
      },
    }
  }

  return buildPreviewForCandidate({service, candidate: candidates[0], mode, actorToken})
}

export async function handleSupplierRenewalPreviewRequest({
  request,
  services = [],
  settings = {},
  history = [],
  scope = {},
  actorToken = '',
  recentServiceId = null,
} = {}) {
  pendingClarifications.delete(fingerprintToken(actorToken))

  const resolution = resolveRenewalServiceTarget({
    request,
    services,
    settings,
    history,
    scope,
    actorToken,
    recentServiceId: recentServiceId || getRecentTarget(actorToken),
  })

  if (resolution.status === 'resolved') {
    return continueWithService({
      service: resolution.service,
      mode: request.mode,
      actorToken,
    })
  }

  if (resolution.status === 'ambiguous') {
    const candidates = resolution.candidates || []

    storeClarification(actorToken, {
      kind: 'service',
      serviceIds: candidates.map(item => String(item.id)),
      mode: request.mode,
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildServiceClarification(candidates),
      data: {type: 'clarification', reason: 'supplier-renewal-preview-service-ambiguous'},
      meta: {
        moduleId: 'facile.renewals',
        source: 'tool-fast',
        intent: 'clarification',
        tool: TOOL_ID,
      },
    }
  }

  return {
    ok: true,
    intent: 'clarification',
    source: 'tool-fast',
    reply:
      resolution.status === 'context-required'
        ? 'Indica quale servizio o dominio vuoi usare per il rinnovo della sottoscrizione fornitore.'
        : `Non ho trovato un servizio corrispondente a "${request?.namedTarget || request?.message || ''}".`,
    data: {
      type: 'clarification',
      reason: `supplier-renewal-preview-${resolution.status || 'not-found'}`,
    },
    meta: {
      moduleId: 'facile.renewals',
      source: 'tool-fast',
      intent: 'clarification',
      tool: TOOL_ID,
    },
  }
}

export async function handlePendingSupplierRenewalPreviewClarification({
  message = '',
  services = [],
  actorToken = '',
} = {}) {
  cleanup()

  const key = fingerprintToken(actorToken)
  const pending = pendingClarifications.get(key)
  if (!pending) return null

  if (pending.kind === 'service') {
    const candidates = services.filter(service => pending.serviceIds.includes(String(service?.id)))
    const selector = parseClarificationSelector(message)

    if (selector) {
      const result = resolveServiceListReference({
        request: {selector},
        items: candidates.map((service, index) => ({
          id: service.id,
          ids: [service.id],
          servizio: service.name || `Servizio ${index + 1}`,
          dominio: service?.domains_id?.name || service?.domain?.name || null,
          cliente: service?.customer?.name || null,
        })),
      })

      if (result.status === 'resolved') {
        const service = candidates.find(item => String(item.id) === String(result.item?.id))
        if (service) {
          pendingClarifications.delete(key)
          return continueWithService({service, mode: pending.mode, actorToken})
        }
      }
    }

    const target = normalizeComparable(message)
    const exact = candidates.filter(service =>
      [service?.id, service?.name, service?.domains_id?.name, service?.domain?.name].some(
        value => normalizeComparable(value) === target
      )
    )

    if (exact.length === 1) {
      pendingClarifications.delete(key)
      return continueWithService({service: exact[0], mode: pending.mode, actorToken})
    }

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildServiceClarification(candidates),
      data: {type: 'clarification', reason: 'supplier-renewal-preview-service-selection-required'},
      meta: {
        moduleId: 'facile.renewals',
        source: 'tool-fast',
        intent: 'clarification',
        tool: TOOL_ID,
      },
    }
  }

  if (pending.kind === 'supplier-subscription') {
    const service = services.find(item => String(item?.id) === String(pending.serviceId))
    if (!service) {
      pendingClarifications.delete(key)
      return null
    }

    const candidates = getSupplierRenewalCandidates(service).filter(item =>
      pending.supplierSubscriptionIds.includes(String(item?.subscription?.id))
    )
    const selection = resolveSupplierCandidate(message, candidates)

    if (selection.status !== 'resolved') {
      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: buildSupplierSubscriptionClarification(service, candidates),
        data: {
          type: 'clarification',
          reason: 'supplier-renewal-preview-subscription-selection-required',
        },
        meta: {
          moduleId: 'facile.renewals',
          source: 'tool-fast',
          intent: 'clarification',
          tool: TOOL_ID,
        },
      }
    }

    pendingClarifications.delete(key)
    return buildPreviewForCandidate({
      service,
      candidate: selection.candidate,
      mode: pending.mode,
      actorToken,
    })
  }

  pendingClarifications.delete(key)
  return null
}
