import {createHash} from 'node:crypto'

import {normalizeSearchText} from '../../../utils/text.js'
import {buildServiceListPayload} from './serviceQueries.js'
import {parseServiceListSelector, resolveServiceListReference} from './serviceListReferences.js'
import {pickPreviousServiceListState} from './serviceListState.js'
import {checkServiceHttpResponse, getPleskRenewalsAudit} from './service.js'

const TOOL_ID = 'renewals.preview-subscription-renewal'
const PREVIEW_CONTEXT_TTL_MS = 30 * 60 * 1000
const pendingClarifications = new Map()
const recentPreviewTargets = new Map()

const DOMAIN_PATTERN =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\b/i

const PREVIEW_REQUEST_PATTERN =
  /\b(?:anteprima|simulazione|proposta)\b[\s\S]{0,60}\b(?:rinnovo|rinnovare)\b|\b(?:prepara|preparare|preparami|simula|simulare|simulami|calcola|calcolare|genera|generare|generami|mostra|mostrami|fammi)\b[\s\S]{0,80}\b(?:rinnovo|anteprima\s+(?:del\s+)?rinnovo|proposta\s+di\s+rinnovo)\b|\b(?:cosa\s+succederebbe|che\s+succede|cosa\s+comporta)\b[\s\S]{0,80}\brinnov/i

const LIST_REQUEST_PATTERN =
  /\b(?:tutti|tutte|elenco|lista|servizi|domini|rinnovi)\b[\s\S]{0,80}\b(?:scadono|in\s+scadenza|da\s+rinnovare|rinnovi\s+imminenti)\b/i

const SUPPLIER_RENEWAL_CONTEXT_PATTERN =
  /\b(?:sottoscrizione\s+)?(?:del\s+|della\s+|di\s+)?(?:fornitore|supplier|provider)\b/i

function fingerprintToken(token = '') {
  return createHash('sha256')
    .update(String(token || ''))
    .digest('hex')
    .slice(0, 24)
}

function cleanupState(now = Date.now()) {
  for (const [key, value] of pendingClarifications.entries()) {
    if (!value || value.expiresAt <= now) pendingClarifications.delete(key)
  }

  for (const [key, value] of recentPreviewTargets.entries()) {
    if (!value || value.expiresAt <= now) recentPreviewTargets.delete(key)
  }
}

function rememberPreviewTarget(actorToken = '', service = null) {
  if (!service?.id) return

  recentPreviewTargets.set(fingerprintToken(actorToken), {
    serviceId: String(service.id),
    expiresAt: Date.now() + PREVIEW_CONTEXT_TTL_MS,
  })
}

function getRecentPreviewTarget(actorToken = '') {
  cleanupState()
  return recentPreviewTargets.get(fingerprintToken(actorToken))?.serviceId || null
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
    /\b(?:anteprima|simulazione|proposta)\s+(?:del\s+|di\s+)?rinnovo\s+(?:di|del|della|per)\s+(.+)$/i,
    /\b(?:prepara|simula|calcola|genera|mostra|mostrami)\s+(?:una\s+|un\s+|l['’]?\s*)?(?:anteprima\s+(?:del\s+)?|proposta\s+di\s+)?rinnovo\s+(?:di|del|della|per)\s+(.+)$/i,
    /\b(?:prepara|simula|calcola|genera)\s+(?:il\s+)?rinnovo\s+(.+)$/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    const target = cleanNamedTarget(match?.[1])
    if (target) return target
  }

  return null
}

export function parseRenewalPreviewRequest(message = '') {
  const text = String(message || '').trim()
  const normalized = normalizeSearchText(text)

  if (!normalized || !PREVIEW_REQUEST_PATTERN.test(normalized)) return null
  if (LIST_REQUEST_PATTERN.test(normalized)) return null
  if (SUPPLIER_RENEWAL_CONTEXT_PATTERN.test(normalized)) return null

  const selector = parseServiceListSelector(text)
  const namedTarget = selector ? null : extractNamedTarget(text)

  return {
    type: 'renewals-renewal-preview-request',
    tool: TOOL_ID,
    message: text,
    selector,
    selectorSource: selector ? 'previous-list' : namedTarget ? 'named-target' : 'context',
    namedTarget,
  }
}

function applyScope(services = [], scope = {}) {
  return (Array.isArray(services) ? services : []).filter(service => {
    if (scope.serviceId && String(service?.id) !== String(scope.serviceId)) return false
    if (scope.customerId && String(service?.customer?.id) !== String(scope.customerId)) return false
    if (scope.groupId && String(service?.customer?.group?.id) !== String(scope.groupId)) return false
    return true
  })
}

function getDomainName(service = {}) {
  return service?.domains_id?.name || service?.domain?.name || null
}

function toServiceCandidate(service = {}) {
  return {
    id: service?.id || null,
    ids: service?.id ? [service.id] : [],
    servizio: service?.name || null,
    dominio: getDomainName(service),
    cliente: service?.customer?.name || null,
    customerId: service?.customer?.id || null,
    gruppo: service?.customer?.group?.name || null,
    groupId: service?.customer?.group?.id || null,
    piano:
      (service?.subscriptions || []).find(subscription => subscription?.isSupplier !== true)?.plan
        ?.name || null,
  }
}

function uniqueById(items = []) {
  const seen = new Set()
  const out = []

  for (const item of items) {
    const id = String(item?.id || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(item)
  }

  return out
}

function resolveNamedService({request, services, scope}) {
  const scoped = applyScope(services, scope)
  const target = normalizeComparable(request?.namedTarget)

  if (!target) return {status: 'not-found', candidates: []}

  const exactId = scoped.find(service => String(service?.id) === String(request.namedTarget))
  if (exactId) return {status: 'resolved', service: exactId}

  const exactDomain = scoped.filter(service => normalizeComparable(getDomainName(service)) === target)
  if (exactDomain.length === 1) return {status: 'resolved', service: exactDomain[0]}
  if (exactDomain.length > 1) return {status: 'ambiguous', candidates: exactDomain}

  const exactName = scoped.filter(service => normalizeComparable(service?.name) === target)
  if (exactName.length === 1) return {status: 'resolved', service: exactName[0]}
  if (exactName.length > 1) return {status: 'ambiguous', candidates: exactName}

  const contains = uniqueById(
    scoped.filter(service => {
      return [
        service?.name,
        getDomainName(service),
        service?.customer?.name,
        service?.customer?.group?.name,
      ].some(value => normalizeComparable(value).includes(target))
    })
  )

  if (contains.length === 1) return {status: 'resolved', service: contains[0]}
  if (contains.length > 1) return {status: 'ambiguous', candidates: contains}

  return {status: 'not-found', candidates: []}
}

function buildPreviousListItems({previousState, services, settings, scope}) {
  if (Array.isArray(previousState?.data?.items)) return previousState.data.items
  if (!previousState?.query) return []

  const payload = buildServiceListPayload({
    services,
    settings,
    message: previousState.sourceMessage || previousState.query.sourceMessage || '',
    previousQuery: previousState.query,
    customerId: scope.customerId || null,
    groupId: scope.groupId || null,
    serviceId: scope.serviceId || null,
  })

  return Array.isArray(payload?.items) ? payload.items : []
}

function findServiceFromReferenceItem(services = [], item = {}) {
  const ids = [...new Set([...(item?.ids || []), item?.id].filter(Boolean).map(String))]
  const byId = services.filter(service => ids.includes(String(service?.id)))
  if (byId.length === 1) return byId[0]

  const domain = normalizeComparable(item?.dominio)
  if (domain) {
    const byDomain = services.filter(
      service => normalizeComparable(getDomainName(service)) === domain
    )
    if (byDomain.length === 1) return byDomain[0]
  }

  const name = normalizeComparable(item?.servizio)
  if (name) {
    const byName = services.filter(service => normalizeComparable(service?.name) === name)
    if (byName.length === 1) return byName[0]
  }

  return null
}

export function resolveRenewalServiceTarget({request, services, settings, history, scope, actorToken, recentServiceId}) {
  if (request?.selector) {
    const previousState = pickPreviousServiceListState(history, scope, settings, request.message)
    const items = buildPreviousListItems({previousState, services, settings, scope})
    const reference = resolveServiceListReference({request: {selector: request.selector}, items})

    if (reference.status !== 'resolved') {
      return {
        status: reference.status || 'not-found',
        candidates: reference.candidates?.map(candidate => candidate.item) || [],
        reference,
      }
    }

    const service = findServiceFromReferenceItem(services, reference.item)
    return service
      ? {status: 'resolved', service}
      : {status: 'not-found', candidates: []}
  }

  if (request?.namedTarget) {
    return resolveNamedService({request, services, scope})
  }

  const contextServiceId =
    scope.serviceId || recentServiceId || getRecentPreviewTarget(actorToken) || null

  if (contextServiceId) {
    const service = services.find(item => String(item?.id) === String(contextServiceId))
    if (service) return {status: 'resolved', service}
  }

  return {status: 'context-required', candidates: []}
}

export function getRenewalCustomerSubscriptions(service = {}) {
  return (Array.isArray(service?.subscriptions) ? service.subscriptions : []).filter(
    subscription => subscription && subscription.isSupplier !== true
  )
}

function getSupplierSubscriptions(service = {}, customerSubscription = null) {
  const nested = [
    ...(customerSubscription?.suppliersSubscriptions || []),
    ...(customerSubscription?.supplierSubscriptions || []),
  ]
  const direct = (service?.subscriptions || []).filter(
    subscription => subscription?.isSupplier === true
  )

  return uniqueById([...nested, ...direct])
}

function toSubscriptionCandidate(subscription = {}, index = 0) {
  return {
    id: subscription?.id || null,
    ids: subscription?.id ? [subscription.id] : [],
    servizio: subscription?.plan?.name || `Sottoscrizione ${index + 1}`,
    piano: subscription?.plan?.name || null,
    cliente: subscription?.plan?.supplier?.name || null,
    dominio: subscription?.endsOn || null,
    startsOn: subscription?.startsOn || null,
    endsOn: subscription?.endsOn || null,
  }
}

function parseClarificationSelector(message = '') {
  const parsed = parseServiceListSelector(message)
  if (parsed) return parsed

  const normalized = normalizeSearchText(message)
  const numeric = normalized.match(/^(?:numero\s+|n\.?\s*)?(\d{1,2})(?:\s*[°º])?$/i)

  if (numeric?.[1] && Number(numeric[1]) > 0) {
    return {kind: 'position', position: Number(numeric[1])}
  }

  return null
}

export function resolveRenewalSubscriptionSelection(message = '', subscriptions = []) {
  const selector = parseClarificationSelector(message)

  if (!selector) {
    const target = normalizeComparable(message)
    const exact = subscriptions.filter(subscription => {
      return (
        String(subscription?.id || '') === String(message || '').trim() ||
        normalizeComparable(subscription?.plan?.name) === target
      )
    })

    return exact.length === 1
      ? {status: 'resolved', subscription: exact[0]}
      : null
  }

  const items = subscriptions.map(toSubscriptionCandidate)
  const result = resolveServiceListReference({request: {selector}, items})

  if (result.status !== 'resolved') return {status: result.status, result}

  const id = result.item?.id
  const subscription = subscriptions.find(item => String(item?.id) === String(id))

  return subscription
    ? {status: 'resolved', subscription}
    : {status: 'not-found', result}
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

export function addMonthsPreservingDay(value, months) {
  const source = normalizeDate(value)
  const duration = Number(months)

  if (!source || !Number.isFinite(duration) || duration <= 0) return null

  const year = source.getFullYear()
  const month = source.getMonth()
  const day = source.getDate()
  const targetMonthStart = new Date(year, month + duration, 1, 12, 0, 0, 0)
  const lastDay = new Date(
    targetMonthStart.getFullYear(),
    targetMonthStart.getMonth() + 1,
    0,
    12,
    0,
    0,
    0
  ).getDate()

  return new Date(
    targetMonthStart.getFullYear(),
    targetMonthStart.getMonth(),
    Math.min(day, lastDay),
    12,
    0,
    0,
    0
  )
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

function mapSupplierSubscription(subscription = {}) {
  return {
    id: subscription.id || null,
    startsOn: subscription.startsOn || null,
    endsOn: subscription.endsOn || null,
    plan: mapPlan(subscription.plan),
    addons: (subscription.addons || []).map(mapAddon),
  }
}

function getIssueServiceIds(issue = {}) {
  return [
    issue?.service?.id,
    issue?.crm?.serviceId,
    ...(issue?.service?.services || []).map(item => item?.id),
  ]
    .filter(Boolean)
    .map(String)
}

function issueMatchesService(issue = {}, service = {}) {
  const serviceId = String(service?.id || '')
  if (serviceId && getIssueServiceIds(issue).includes(serviceId)) return true

  const domainId = String(service?.domains_id?.id || '')
  if (domainId && String(issue?.service?.domainId || '') === domainId) return true

  const domainName = normalizeComparable(getDomainName(service))
  if (domainName && normalizeComparable(issue?.service?.domainName) === domainName) return true

  const integrationId = String(service?.pleskDomain?.integration_id || '')
  if (
    integrationId &&
    [issue?.service?.integrationId, issue?.crm?.integrationId, issue?.plesk?.guid]
      .filter(Boolean)
      .map(String)
      .includes(integrationId)
  ) {
    return true
  }

  return false
}

function extractPleskIssues(audit = null, service = {}) {
  const items = Array.isArray(audit?.items) ? audit.items : []

  return items
    .filter(issue => issueMatchesService(issue, service))
    .slice(0, 20)
    .map(issue => ({
      severity: issue.severity || 'warning',
      code: issue.code || null,
      title: issue.title || null,
      message: issue.message || null,
      crm: issue.crm || null,
      plesk: issue.plesk || null,
    }))
}

export function buildRenewalPreviewPayload({
  service,
  customerSubscription,
  httpCheck = null,
  httpCheckError = null,
  pleskAudit = null,
  pleskAuditError = null,
} = {}) {
  const blockers = []
  const warnings = []
  const checks = []

  const currentEndDate = normalizeDate(customerSubscription?.endsOn)
  const durationMonths = Number(customerSubscription?.plan?.duration)
  const proposedEndDate = addMonthsPreservingDay(currentEndDate, durationMonths)
  const supplierSubscriptions = getSupplierSubscriptions(service, customerSubscription)
  const pleskIssues = extractPleskIssues(pleskAudit, service)
  const hasPlesk = Boolean(service?.pleskDomain?.id)
  const domain = getDomainName(service)

  if (!customerSubscription?.id) {
    blockers.push({code: 'customer-subscription-missing', message: 'Sottoscrizione cliente mancante.'})
  }

  if (!currentEndDate) {
    blockers.push({code: 'customer-expiry-missing', message: 'Scadenza cliente mancante o non valida.'})
  }

  if (!customerSubscription?.plan?.id) {
    blockers.push({code: 'customer-plan-missing', message: 'Piano cliente mancante.'})
  }

  if (!Number.isFinite(durationMonths) || durationMonths <= 0) {
    blockers.push({
      code: 'plan-duration-missing',
      message: 'Durata del piano mancante o non valida: non posso calcolare la nuova scadenza.',
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
      message: 'Il servizio è marcato DA TRASFERIRE.',
    })
  }

  if (hasPlesk && service?.pleskPlansSync === false) {
    warnings.push({
      code: 'plesk-plan-sync-disabled',
      message: 'La sincronizzazione del piano Plesk è disattivata per questo servizio.',
    })
  }

  if (customerSubscription?.plan?.missingPrice === true) {
    warnings.push({
      code: 'customer-plan-price-missing',
      message: 'Il prezzo del piano cliente non è disponibile.',
    })
  }

  if (!supplierSubscriptions.length) {
    warnings.push({
      code: 'supplier-subscription-missing',
      message: 'Non è presente una sottoscrizione fornitore collegata.',
    })
  }

  for (const supplierSubscription of supplierSubscriptions) {
    if (!supplierSubscription?.endsOn) {
      warnings.push({
        code: 'supplier-expiry-missing',
        message: `La sottoscrizione fornitore ${supplierSubscription?.id || 'senza ID'} non ha una scadenza.`,
      })
    }

    if (supplierSubscription?.plan?.missingPrice === true) {
      warnings.push({
        code: 'supplier-plan-price-missing',
        message: `Il prezzo del piano fornitore ${supplierSubscription?.plan?.name || '—'} non è disponibile.`,
      })
    }

    const supplierEndDate = normalizeDate(supplierSubscription?.endsOn)
    if (supplierEndDate && proposedEndDate && supplierEndDate < proposedEndDate) {
      warnings.push({
        code: 'supplier-expiry-before-proposed-customer-expiry',
        message: `La scadenza fornitore ${formatDate(supplierEndDate)} precede la nuova scadenza cliente ${formatDate(proposedEndDate)}.`,
      })
    }
  }

  if (pleskAuditError) {
    warnings.push({
      code: 'plesk-audit-unavailable',
      message: `Audit Plesk non disponibile: ${pleskAuditError}`,
    })
  }

  for (const issue of pleskIssues) {
    const destination = issue.severity === 'error' ? blockers : warnings
    destination.push({
      code: issue.code || 'plesk-issue',
      message: issue.title || issue.message || 'Anomalia Plesk rilevata.',
    })
  }

  if (httpCheckError) {
    warnings.push({
      code: 'http-check-unavailable',
      message: `Controllo HTTP non disponibile: ${httpCheckError}`,
    })
  } else if (httpCheck?.checked && httpCheck?.ok !== true) {
    warnings.push({
      code: 'http-check-failed',
      message: httpCheck?.status
        ? `Il dominio ha risposto con stato HTTP ${httpCheck.status}.`
        : 'Il dominio non risulta raggiungibile.',
    })
  }

  checks.push(
    {
      code: 'customer-subscription',
      status: customerSubscription?.id ? 'ok' : 'error',
      label: 'Sottoscrizione cliente',
    },
    {
      code: 'customer-expiry',
      status: currentEndDate ? 'ok' : 'error',
      label: 'Scadenza cliente',
    },
    {
      code: 'plan-duration',
      status: Number.isFinite(durationMonths) && durationMonths > 0 ? 'ok' : 'error',
      label: 'Durata piano',
    },
    {
      code: 'dont-renew',
      status: service?.dontRenew === true || service?.dont_renew === true ? 'error' : 'ok',
      label: 'Flag NON RINNOVARE',
    },
    {
      code: 'supplier-subscription',
      status: supplierSubscriptions.length ? 'ok' : 'warning',
      label: 'Sottoscrizione fornitore',
    },
    {
      code: 'plesk',
      status: !hasPlesk
        ? 'not-applicable'
        : pleskAuditError
          ? 'warning'
          : pleskIssues.some(issue => issue.severity === 'error')
            ? 'error'
            : pleskIssues.length
              ? 'warning'
              : 'ok',
      label: 'Plesk',
    },
    {
      code: 'http',
      status: !domain
        ? 'not-applicable'
        : httpCheckError
          ? 'warning'
          : httpCheck?.ok === true
            ? 'ok'
            : 'warning',
      label: 'HTTP/HTTPS',
    }
  )

  const systems = ['CRM rinnovi']
  if (supplierSubscriptions.length) systems.push('fornitore')
  if (hasPlesk) systems.push('Plesk')

  return {
    type: 'renewal-preview',
    previewOnly: true,
    executionAllowed: false,
    status: blockers.length ? 'blocked' : 'ready',
    service: {
      id: service?.id || null,
      name: service?.name || null,
      domain,
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
    customerSubscription: {
      id: customerSubscription?.id || null,
      startsOn: customerSubscription?.startsOn || null,
      currentEndDate: customerSubscription?.endsOn || null,
      proposedEndDate: proposedEndDate ? toIsoDate(proposedEndDate) : null,
      plan: mapPlan(customerSubscription?.plan),
      addons: (customerSubscription?.addons || []).map(mapAddon),
    },
    supplierSubscriptions: supplierSubscriptions.map(mapSupplierSubscription),
    flags: {
      dontRenew: service?.dontRenew === true || service?.dont_renew === true,
      autoRenew: service?.autoRenew === true || service?.auto_renew === true,
      toRenew: service?.toRenew === true || service?.to_renew === true,
      toTransfer: service?.toTransfer || service?.to_transfer || null,
      pleskPlansSync: service?.pleskPlansSync !== false,
      authCodeSet: Boolean(service?.authCode || service?.auth_code),
    },
    plesk: {
      connected: hasPlesk,
      pleskDomainId: service?.pleskDomain?.id || null,
      integrationId: service?.pleskDomain?.integration_id || null,
      planSyncEnabled: service?.pleskPlansSync !== false,
      issues: pleskIssues,
    },
    http: domain
      ? {
          checked: httpCheck?.checked === true,
          ok: httpCheck?.ok === true,
          status: httpCheck?.status ?? null,
          protocol: httpCheck?.protocolTried || null,
          finalUrl: httpCheck?.finalUrl || null,
          error: httpCheckError || null,
        }
      : null,
    systemsToCoordinate: systems,
    checks,
    blockers,
    warnings,
  }
}

export function buildRenewalPreviewReply(payload = {}) {
  const serviceLabel = payload?.service?.domain || payload?.service?.name || 'servizio'
  const customerSub = payload?.customerSubscription || {}
  const lines = [`Anteprima rinnovo per "${serviceLabel}".`]

  lines.push(
    `Scadenza cliente: ${formatDate(customerSub.currentEndDate)} → ${formatDate(
      customerSub.proposedEndDate
    )}.`
  )

  if (customerSub.plan?.name) {
    const duration = customerSub.plan.durationMonths
      ? `, durata ${customerSub.plan.durationMonths} mesi`
      : ''
    lines.push(`Piano: ${customerSub.plan.name}${duration}.`)
  }

  if (customerSub.addons?.length) {
    lines.push(`Add-on: ${customerSub.addons.map(item => item.name || item.id).join(', ')}.`)
  }

  if (payload.supplierSubscriptions?.length) {
    for (const supplierSub of payload.supplierSubscriptions) {
      const supplierName = supplierSub.plan?.supplier?.name || supplierSub.plan?.name || 'fornitore'
      lines.push(`Scadenza ${supplierName}: ${formatDate(supplierSub.endsOn)}.`)
    }
  } else {
    lines.push('Sottoscrizione fornitore: non presente.')
  }

  lines.push(
    `Flag: DA RINNOVARE ${payload.flags?.toRenew ? 'attivo' : 'non attivo'}, rinnovo automatico ${
      payload.flags?.autoRenew ? 'attivo' : 'non attivo'
    }, NON RINNOVARE ${payload.flags?.dontRenew ? 'attivo' : 'non attivo'}.`
  )

  if (payload.systemsToCoordinate?.length) {
    lines.push(`Sistemi da coordinare in un rinnovo reale: ${payload.systemsToCoordinate.join(', ')}.`)
  }

  if (payload.plesk?.connected) {
    const issueCount = payload.plesk.issues?.length || 0
    lines.push(
      issueCount
        ? `Plesk: collegato, con ${issueCount} anomalia${issueCount === 1 ? '' : 'e'} rilevata${issueCount === 1 ? '' : 'e'}.`
        : 'Plesk: collegato, nessuna anomalia rilevata dall’audit.'
    )
  } else {
    lines.push('Plesk: non collegato.')
  }

  if (payload.http?.checked) {
    lines.push(
      payload.http.ok
        ? `HTTP/HTTPS: risposta ${payload.http.status || 200}${payload.http.finalUrl ? ` da ${payload.http.finalUrl}` : ''}.`
        : payload.http.status
          ? `HTTP/HTTPS: risposta ${payload.http.status}.`
          : 'HTTP/HTTPS: dominio non raggiungibile.'
    )
  }

  if (payload.blockers?.length) {
    lines.push(`Blocchi: ${payload.blockers.map(item => item.message).join(' ')}`)
  }

  if (payload.warnings?.length) {
    lines.push(`Avvisi: ${payload.warnings.map(item => item.message).join(' ')}`)
  }

  lines.push('Questa è solo un’anteprima: nessuna modifica è stata eseguita.')

  return lines.join('\n')
}

export function buildRenewalServiceClarification(candidates = []) {
  const lines = ['Ho trovato più servizi compatibili. Quale vuoi usare per l’anteprima del rinnovo?']

  candidates.slice(0, 20).forEach((service, index) => {
    const domain = getDomainName(service) || '—'
    const customer = service?.customer?.name || '—'
    const group = service?.customer?.group?.name || null
    lines.push(
      `${index + 1}. ${service?.name || domain} | dominio ${domain} | cliente ${customer}${group ? ` | gruppo ${group}` : ''}`
    )
  })

  return lines.join('\n')
}

export function buildRenewalSubscriptionClarification(service, subscriptions = []) {
  const label = getDomainName(service) || service?.name || service?.id
  const lines = [
    `Il servizio "${label}" ha più sottoscrizioni cliente. Quale vuoi usare per l’anteprima?`,
  ]

  subscriptions.forEach((subscription, index) => {
    lines.push(
      `${index + 1}. ${subscription?.plan?.name || 'Piano non indicato'} | inizio ${formatDate(
        subscription?.startsOn
      )} | scadenza ${formatDate(subscription?.endsOn)} | ID ${subscription?.id || '—'}`
    )
  })

  return lines.join('\n')
}

function storeClarification(actorToken, payload) {
  pendingClarifications.set(fingerprintToken(actorToken), {
    ...payload,
    expiresAt: Date.now() + PREVIEW_CONTEXT_TTL_MS,
  })
}

export function hasPendingRenewalPreviewClarification({actorToken = ''} = {}) {
  cleanupState()
  return pendingClarifications.has(fingerprintToken(actorToken))
}

export async function loadRenewalExternalChecks(service) {
  const domain = getDomainName(service)
  const hasPlesk = Boolean(service?.pleskDomain?.id)

  const [httpResult, auditResult] = await Promise.allSettled([
    domain
      ? checkServiceHttpResponse({domain, protocol: 'auto'})
      : Promise.resolve(null),
    hasPlesk ? getPleskRenewalsAudit() : Promise.resolve(null),
  ])

  return {
    httpCheck: httpResult.status === 'fulfilled' ? httpResult.value : null,
    httpCheckError:
      httpResult.status === 'rejected' ? httpResult.reason?.message || String(httpResult.reason) : null,
    pleskAudit: auditResult.status === 'fulfilled' ? auditResult.value : null,
    pleskAuditError:
      auditResult.status === 'rejected' ? auditResult.reason?.message || String(auditResult.reason) : null,
  }
}

async function buildPreviewForResolvedService({service, customerSubscription, actorToken}) {
  const checks = await loadRenewalExternalChecks(service)
  const payload = buildRenewalPreviewPayload({
    service,
    customerSubscription,
    ...checks,
  })

  rememberPreviewTarget(actorToken, service)

  return {
    ok: true,
    intent: 'renewal-preview',
    source: 'tool-fast',
    reply: buildRenewalPreviewReply(payload),
    data: payload,
    meta: {
      moduleId: 'facile.renewals',
      source: 'tool-fast',
      intent: 'renewal-preview',
      tool: TOOL_ID,
      previewOnly: true,
    },
  }
}

async function continueWithService({service, actorToken}) {
  const subscriptions = getRenewalCustomerSubscriptions(service)

  if (!subscriptions.length) {
    const payload = buildRenewalPreviewPayload({service, customerSubscription: null})

    return {
      ok: true,
      intent: 'renewal-preview',
      source: 'tool-fast',
      reply: buildRenewalPreviewReply(payload),
      data: payload,
      meta: {
        moduleId: 'facile.renewals',
        source: 'tool-fast',
        intent: 'renewal-preview',
        tool: TOOL_ID,
        previewOnly: true,
      },
    }
  }

  if (subscriptions.length > 1) {
    storeClarification(actorToken, {
      kind: 'subscription',
      serviceId: String(service.id),
      subscriptionIds: subscriptions.map(item => String(item.id)),
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildRenewalSubscriptionClarification(service, subscriptions),
      data: {
        type: 'clarification',
        reason: 'renewal-preview-subscription-ambiguous',
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

  return buildPreviewForResolvedService({
    service,
    customerSubscription: subscriptions[0],
    actorToken,
  })
}

export async function handleRenewalPreviewRequest({
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
    recentServiceId,
  })

  if (resolution.status === 'resolved') {
    return continueWithService({service: resolution.service, actorToken})
  }

  if (resolution.status === 'ambiguous') {
    const candidates = resolution.candidates || []

    storeClarification(actorToken, {
      kind: 'service',
      serviceIds: candidates.map(item => String(item.id)),
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildRenewalServiceClarification(candidates),
      data: {
        type: 'clarification',
        reason: 'renewal-preview-service-ambiguous',
      },
      meta: {
        moduleId: 'facile.renewals',
        source: 'tool-fast',
        intent: 'clarification',
        tool: TOOL_ID,
      },
    }
  }

  const reply =
    resolution.status === 'context-required'
      ? 'Indica quale servizio o dominio vuoi rinnovare, oppure usa un riferimento alla lista precedente.'
      : `Non ho trovato un servizio corrispondente a "${request?.namedTarget || request?.message || ''}".`

  return {
    ok: true,
    intent: 'clarification',
    source: 'tool-fast',
    reply,
    data: {
      type: 'clarification',
      reason: `renewal-preview-${resolution.status || 'not-found'}`,
    },
    meta: {
      moduleId: 'facile.renewals',
      source: 'tool-fast',
      intent: 'clarification',
      tool: TOOL_ID,
    },
  }
}

export async function handlePendingRenewalPreviewClarification({
  message = '',
  services = [],
  actorToken = '',
} = {}) {
  cleanupState()

  const key = fingerprintToken(actorToken)
  const pending = pendingClarifications.get(key)
  if (!pending) return null

  if (pending.kind === 'service') {
    const candidates = services.filter(service => pending.serviceIds.includes(String(service?.id)))
    const selector = parseClarificationSelector(message)

    if (!selector) {
      const target = normalizeComparable(message)
      const exact = candidates.filter(service => {
        return (
          String(service?.id || '') === String(message || '').trim() ||
          normalizeComparable(service?.name) === target ||
          normalizeComparable(getDomainName(service)) === target
        )
      })

      if (exact.length === 1) {
        pendingClarifications.delete(key)
        return continueWithService({service: exact[0], actorToken})
      }

      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: buildRenewalServiceClarification(candidates),
        data: {type: 'clarification', reason: 'renewal-preview-service-selection-required'},
        meta: {moduleId: 'facile.renewals', source: 'tool-fast', intent: 'clarification', tool: TOOL_ID},
      }
    }

    const result = resolveServiceListReference({
      request: {selector},
      items: candidates.map(toServiceCandidate),
    })

    if (result.status !== 'resolved') {
      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: buildRenewalServiceClarification(candidates),
        data: {type: 'clarification', reason: `renewal-preview-service-${result.status}`},
        meta: {moduleId: 'facile.renewals', source: 'tool-fast', intent: 'clarification', tool: TOOL_ID},
      }
    }

    const service = candidates.find(item => String(item?.id) === String(result.item?.id))
    if (!service) return null

    pendingClarifications.delete(key)
    return continueWithService({service, actorToken})
  }

  if (pending.kind === 'subscription') {
    const service = services.find(item => String(item?.id) === String(pending.serviceId))
    if (!service) {
      pendingClarifications.delete(key)
      return null
    }

    const subscriptions = getRenewalCustomerSubscriptions(service).filter(item =>
      pending.subscriptionIds.includes(String(item?.id))
    )
    const selection = resolveRenewalSubscriptionSelection(message, subscriptions)

    if (selection?.status !== 'resolved') {
      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: buildRenewalSubscriptionClarification(service, subscriptions),
        data: {type: 'clarification', reason: 'renewal-preview-subscription-selection-required'},
        meta: {moduleId: 'facile.renewals', source: 'tool-fast', intent: 'clarification', tool: TOOL_ID},
      }
    }

    pendingClarifications.delete(key)
    return buildPreviewForResolvedService({
      service,
      customerSubscription: selection.subscription,
      actorToken,
    })
  }

  pendingClarifications.delete(key)
  return null
}
