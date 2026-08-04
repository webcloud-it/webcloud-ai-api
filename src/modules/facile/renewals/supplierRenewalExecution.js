import {createHash, randomUUID} from 'node:crypto'

import {normalizeSearchText} from '../../../utils/text.js'
import {parseServiceListSelector, resolveServiceListReference} from './serviceListReferences.js'
import {resolveRenewalServiceTarget} from './renewalPreview.js'
import {
  buildSupplierRenewalPreviewPayload,
  buildSupplierRenewalPreviewReply,
  getSupplierRenewalCandidates,
  parseSupplierRenewalPreviewRequest,
} from './supplierRenewalPreview.js'
import {renewSupplierSubscription} from './service.js'

const TOOL_ID = 'renewals.renew-supplier-subscription'
const PROPOSAL_TTL_MS = 10 * 60 * 1000
const CONTEXT_TTL_MS = 30 * 60 * 1000

const proposals = new Map()
const pendingClarifications = new Map()
const recentCompletedRenewals = new Map()

const PREVIEW_ONLY_PATTERN =
  /\b(?:anteprima|simula|simulazione|proposta|prepara|preparami|calcola|mostra|mostrami|fammi\s+vedere|cosa\s+succederebbe|che\s+succede|cosa\s+comporta)\b/i

const EXPLICIT_EXECUTION_PATTERN =
  /\b(?:rinnova|rinnovami|rinnovare|esegui|eseguire|effettua|effettuare|completa|completare|avvia|avviare|procedi|procedere)\b/i

const ALIGN_EXECUTION_PATTERN =
  /\b(?:allinea|allineare|copia|copiare|porta|portare|imposta|impostare|usa|usare|sincronizza|sincronizzare)\b[\s\S]{0,100}\bscadenz[ae]\b[\s\S]{0,50}\b(?:fornitore|supplier|provider)\b/i

const CONFIRM_PATTERNS = [
  /^(?:si|sì|confermo|conferma|ok|okay|va bene|d['’]?accordo)$/i,
  /^(?:procedi|procedi pure|vai|vai pure|esegui|esegui pure|fallo|applica|salva)$/i,
  /^(?:si|sì)[,\s]+(?:confermo|procedi|vai|esegui|fallo|ok|va bene)$/i,
]

const CANCEL_PATTERNS = [
  /^(?:no|annulla|annullo|cancella|stop|ferma|fermati|non procedere|non farlo|lascia stare|lascia perdere)$/i,
  /^(?:annulla|cancella|revoca)\s+(?:questa|la)\s+(?:proposta|operazione|azione|modifica)$/i,
]

const UNDO_COMPLETED_PATTERN =
  /^(?:annulla|annullo|undo|revert|ripristina|revoca)(?:\s+(?:l['’]?\s*)?(?:ultima|scorsa|precedente)\s+(?:operazione|azione|modifica|rinnovo))?$/i

function fingerprintToken(token = '') {
  return createHash('sha256')
    .update(String(token || ''))
    .digest('hex')
    .slice(0, 24)
}

function cleanup(now = Date.now()) {
  for (const [actionId, proposal] of proposals.entries()) {
    const finishedAt = proposal.finishedAt || proposal.expiresAt

    if (
      proposal.expiresAt <= now ||
      (proposal.status !== 'pending' && finishedAt + PROPOSAL_TTL_MS <= now)
    ) {
      proposals.delete(actionId)
    }
  }

  for (const [key, pending] of pendingClarifications.entries()) {
    if (!pending || pending.expiresAt <= now) pendingClarifications.delete(key)
  }

  for (const [key, recent] of recentCompletedRenewals.entries()) {
    if (!recent || recent.expiresAt <= now) recentCompletedRenewals.delete(key)
  }
}

function normalizeComparable(value = '') {
  return normalizeSearchText(value)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[/?#].*$/, '')
    .replace(/[.,!?;:]+$/g, '')
    .trim()
}

function normalizeNullableId(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'object') return value?.id ? String(value.id) : null
  const normalized = String(value).trim()
  return normalized || null
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('it-IT').format(date)
}

function parseDecision(message = '') {
  const text = normalizeSearchText(message)
    .replace(/[.!?;:]+$/g, '')
    .trim()

  if (CONFIRM_PATTERNS.some(pattern => pattern.test(text))) return 'confirm'
  if (CANCEL_PATTERNS.some(pattern => pattern.test(text))) return 'cancel'
  return null
}

function buildMeta(intent, extra = {}) {
  return {
    moduleId: 'facile.renewals',
    source: 'tool-fast',
    intent,
    tool: TOOL_ID,
    ...extra,
  }
}

export function parseSupplierRenewalExecutionRequest(message = '') {
  const text = String(message || '').trim()
  const normalized = normalizeSearchText(text)

  if (!normalized || PREVIEW_ONLY_PATTERN.test(normalized)) return null

  const previewRequest = parseSupplierRenewalPreviewRequest(text)
  if (!previewRequest) return null

  const isExecution =
    EXPLICIT_EXECUTION_PATTERN.test(normalized) || ALIGN_EXECUTION_PATTERN.test(normalized)

  if (!isExecution) return null

  return {
    ...previewRequest,
    type: 'renewals-supplier-renewal-execution-request',
    tool: TOOL_ID,
  }
}

function buildBlockedResult(preview) {
  return {
    ok: true,
    intent: 'action-error',
    source: 'tool-fast',
    reply: [
      buildSupplierRenewalPreviewReply(preview),
      '',
      'Il rinnovo fornitore non può essere eseguito finché i blocchi indicati non vengono risolti.',
    ].join('\n'),
    data: {
      type: 'action-error',
      action: {
        tool: TOOL_ID,
        requiresConfirmation: false,
      },
      preview,
      error: {
        code: 'supplier-renewal-preview-blocked',
        details: preview?.blockers || [],
      },
    },
    meta: buildMeta('action-error', {
      actionStatus: 'blocked',
      errorCode: 'supplier-renewal-preview-blocked',
    }),
  }
}

export function buildSupplierRenewalExecutionProposalFromPreview({
  service,
  candidate,
  preview,
  actorToken = '',
} = {}) {
  cleanup()

  const supplierSubscription = candidate?.subscription || null
  const customerSubscription = candidate?.customerSubscription || null

  if (!service?.id || !supplierSubscription?.id || !preview) {
    return {
      ok: true,
      intent: 'action-error',
      source: 'tool-fast',
      reply:
        'Non posso costruire la proposta di rinnovo fornitore perché mancano servizio, sottoscrizione o anteprima.',
      data: {
        type: 'action-error',
        error: {code: 'supplier-renewal-proposal-incomplete'},
      },
      meta: buildMeta('action-error', {
        errorCode: 'supplier-renewal-proposal-incomplete',
      }),
    }
  }

  if (preview.status !== 'ready' || preview.blockers?.length) {
    return buildBlockedResult(preview)
  }

  const currentEndDate = preview.supplierSubscription.currentEndDate
  const newEndDate = preview.supplierSubscription.proposedEndDate

  if (!currentEndDate || !newEndDate) return buildBlockedResult(preview)

  const actionId = randomUUID()
  const now = Date.now()
  const targetLabel = preview.service.domain || preview.service.name || String(service.id)
  const supplierName = preview.supplierSubscription.plan?.supplier?.name || 'fornitore'

  const proposal = {
    actionId,
    tool: TOOL_ID,
    status: 'pending',
    actorFingerprint: fingerprintToken(actorToken),
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
    target: {
      type: 'service',
      id: String(service.id),
      label: targetLabel,
    },
    subscription: {
      id: String(supplierSubscription.id),
      type: 'supplier',
      supplierId: preview.supplierSubscription.plan?.supplier?.id || null,
      supplierName,
      planId: preview.supplierSubscription.plan?.id || null,
      planName: preview.supplierSubscription.plan?.name || null,
    },
    customerSubscription: customerSubscription?.id
      ? {
          id: String(customerSubscription.id),
          endDate: customerSubscription.endsOn || null,
        }
      : null,
    mode: preview.mode,
    expected: {
      startDate: supplierSubscription.startsOn || null,
      endDate: currentEndDate,
      planId: preview.supplierSubscription.plan?.id || null,
      durationMonths: preview.supplierSubscription.plan?.durationMonths || null,
      dontRenew: preview.flags.dontRenew === true,
      toTransferId: normalizeNullableId(preview.flags.toTransfer),
      customerSubscriptionId: customerSubscription?.id || null,
      customerEndDate: customerSubscription?.endsOn || null,
    },
    desired: {
      startDate: currentEndDate,
      endDate: newEndDate,
      lastRenewalDate: currentEndDate,
    },
    preview,
  }

  proposals.set(actionId, proposal)

  const warnings = preview.warnings?.length
    ? `\n\nAvvisi: ${preview.warnings.map(item => item.message).join(' ')}`
    : ''

  const previewText = buildSupplierRenewalPreviewReply(preview, {
    includePreviewDisclaimer: false,
  })

  return {
    ok: true,
    intent: 'action-proposal',
    source: 'tool-fast',
    reply: [
      previewText,
      '',
      `Aggiornerò nel CRM la sottoscrizione di ${supplierName}, portando la scadenza dal ${formatDate(
        currentEndDate
      )} al ${formatDate(newEndDate)}.`,
      'Non verrà eseguito alcun ordine o rinnovo nel portale/API del fornitore.',
      'La sottoscrizione cliente e Plesk non verranno modificati.',
      `Confermi?${warnings}`,
    ].join('\n'),
    data: {
      type: 'action-preview',
      action: {
        actionId,
        tool: TOOL_ID,
        requiresConfirmation: true,
        reversible: false,
        expiresAt: new Date(proposal.expiresAt).toISOString(),
        target: proposal.target,
        subscription: proposal.subscription,
      },
      preview,
    },
    meta: buildMeta('action-proposal', {
      actionId,
      actionStatus: 'pending',
      requiresConfirmation: true,
      reversible: false,
    }),
  }
}

function toCandidateItem(candidate = {}, index = 0) {
  const subscription = candidate.subscription || {}

  return {
    id: subscription.id || null,
    ids: subscription.id ? [subscription.id] : [],
    servizio: subscription?.plan?.name || `Sottoscrizione fornitore ${index + 1}`,
    dominio: subscription?.plan?.supplier?.name || null,
    cliente: candidate.customerSubscription?.plan?.name || null,
    gruppo: subscription?.endsOn || null,
    piano: subscription?.plan?.name || null,
  }
}

function buildServiceClarification(candidates = []) {
  const lines = ['Ho trovato più servizi compatibili. Per quale vuoi eseguire il rinnovo fornitore?']

  candidates.forEach((service, index) => {
    const domain = service?.domains_id?.name || service?.domain?.name || '—'
    const customer = service?.customer?.name || '—'
    lines.push(`${index + 1}. ${service?.name || domain} | dominio ${domain} | cliente ${customer}`)
  })

  return lines.join('\n')
}

function buildSubscriptionClarification(service, candidates = []) {
  const label = service?.domains_id?.name || service?.domain?.name || service?.name || service?.id
  const lines = [`Il servizio "${label}" ha più sottoscrizioni fornitore. Quale vuoi rinnovare?`]

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

function rememberClarification(actorToken, payload) {
  pendingClarifications.set(fingerprintToken(actorToken), {
    ...payload,
    expiresAt: Date.now() + CONTEXT_TTL_MS,
  })
}

function createProposalForCandidate({service, candidate, mode, actorToken}) {
  const preview = buildSupplierRenewalPreviewPayload({
    service,
    supplierSubscription: candidate?.subscription || null,
    customerSubscription: candidate?.customerSubscription || null,
    mode,
  })

  return buildSupplierRenewalExecutionProposalFromPreview({
    service,
    candidate,
    preview,
    actorToken,
  })
}

function continueWithService({service, mode, actorToken}) {
  const candidates = getSupplierRenewalCandidates(service)

  if (!candidates.length) {
    const preview = buildSupplierRenewalPreviewPayload({
      service,
      supplierSubscription: null,
      customerSubscription: null,
      mode,
    })
    return buildBlockedResult(preview)
  }

  if (candidates.length > 1) {
    rememberClarification(actorToken, {
      kind: 'subscription',
      serviceId: String(service.id),
      subscriptionIds: candidates.map(item => String(item.subscription.id)),
      mode,
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildSubscriptionClarification(service, candidates),
      data: {
        type: 'clarification',
        reason: 'supplier-renewal-execution-subscription-ambiguous',
        serviceId: service.id,
      },
      meta: buildMeta('clarification'),
    }
  }

  return createProposalForCandidate({
    service,
    candidate: candidates[0],
    mode,
    actorToken,
  })
}

export function hasPendingSupplierRenewalExecutionClarification({actorToken = ''} = {}) {
  cleanup()
  return pendingClarifications.has(fingerprintToken(actorToken))
}

export async function handleSupplierRenewalExecutionRequest({
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
    return continueWithService({
      service: resolution.service,
      mode: request.mode,
      actorToken,
    })
  }

  if (resolution.status === 'ambiguous') {
    const candidates = resolution.candidates || []

    rememberClarification(actorToken, {
      kind: 'service',
      serviceIds: candidates.map(item => String(item.id)),
      mode: request.mode,
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildServiceClarification(candidates),
      data: {type: 'clarification', reason: 'supplier-renewal-execution-service-ambiguous'},
      meta: buildMeta('clarification'),
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
      reason: `supplier-renewal-execution-${resolution.status || 'not-found'}`,
    },
    meta: buildMeta('clarification'),
  }
}

export async function handlePendingSupplierRenewalExecutionClarification({
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
    let selected = null

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
        selected = candidates.find(item => String(item.id) === String(result.item?.id)) || null
      }
    }

    if (!selected) {
      const target = normalizeComparable(message)
      const exact = candidates.filter(service =>
        [service?.id, service?.name, service?.domains_id?.name, service?.domain?.name].some(
          value => normalizeComparable(value) === target
        )
      )
      if (exact.length === 1) selected = exact[0]
    }

    if (!selected) {
      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: buildServiceClarification(candidates),
        data: {type: 'clarification', reason: 'supplier-renewal-execution-service-selection-required'},
        meta: buildMeta('clarification'),
      }
    }

    pendingClarifications.delete(key)
    return continueWithService({service: selected, mode: pending.mode, actorToken})
  }

  if (pending.kind === 'subscription') {
    const service = services.find(item => String(item?.id) === String(pending.serviceId))
    if (!service) {
      pendingClarifications.delete(key)
      return null
    }

    const candidates = getSupplierRenewalCandidates(service).filter(item =>
      pending.subscriptionIds.includes(String(item?.subscription?.id))
    )
    const selection = resolveSupplierCandidate(message, candidates)

    if (selection.status !== 'resolved') {
      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: buildSubscriptionClarification(service, candidates),
        data: {
          type: 'clarification',
          reason: 'supplier-renewal-execution-subscription-selection-required',
        },
        meta: buildMeta('clarification'),
      }
    }

    pendingClarifications.delete(key)
    return createProposalForCandidate({
      service,
      candidate: selection.candidate,
      mode: pending.mode,
      actorToken,
    })
  }

  pendingClarifications.delete(key)
  return null
}

function getPendingProposalForActor(actorToken = '') {
  cleanup()
  const fingerprint = fingerprintToken(actorToken)

  return (
    [...proposals.values()]
      .filter(proposal => proposal.actorFingerprint === fingerprint && proposal.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null
  )
}

export function hasSupplierRenewalExecutionProposal(actionId = '') {
  cleanup()
  return proposals.has(String(actionId || '').trim())
}

export async function handlePendingSupplierRenewalExecutionDecisionMessage({
  message = '',
  actorToken = '',
  executeFn = renewSupplierSubscription,
} = {}) {
  const decision = parseDecision(message)
  if (!decision) return null

  const proposal = getPendingProposalForActor(actorToken)
  if (!proposal) return null

  return handleSupplierRenewalExecutionDecision({
    action: {actionId: proposal.actionId, decision},
    actorToken,
    executeFn,
  })
}

function actionError(proposal, code, reply, details = null) {
  return {
    ok: true,
    intent: 'action-error',
    source: 'tool-fast',
    reply,
    data: {
      type: 'action-error',
      action: proposal
        ? {
            actionId: proposal.actionId,
            tool: proposal.tool,
            target: proposal.target,
            subscription: proposal.subscription,
          }
        : null,
      error: {code, details},
    },
    meta: buildMeta('action-error', {
      actionId: proposal?.actionId || null,
      actionStatus: proposal?.status || 'not-found',
      errorCode: code,
    }),
  }
}

export async function handleSupplierRenewalExecutionDecision({
  action = null,
  actorToken = '',
  executeFn = renewSupplierSubscription,
} = {}) {
  cleanup()

  const actionId = String(action?.actionId || '').trim()
  const decision = String(action?.decision || '').trim().toLowerCase()
  const proposal = proposals.get(actionId)

  if (!proposal) return null

  if (!['confirm', 'cancel'].includes(decision)) {
    return actionError(
      proposal,
      'invalid-decision',
      'La decisione deve essere "confirm" oppure "cancel".'
    )
  }

  if (proposal.actorFingerprint !== fingerprintToken(actorToken)) {
    return actionError(proposal, 'action-owner-mismatch', 'Questa proposta appartiene a un’altra sessione.')
  }

  if (proposal.expiresAt <= Date.now()) {
    proposal.status = 'expired'
    proposal.finishedAt = Date.now()
    return actionError(
      proposal,
      'action-expired',
      'La proposta è scaduta. Ripeti la richiesta di rinnovo fornitore.'
    )
  }

  if (proposal.status !== 'pending') {
    return actionError(proposal, 'action-already-finalized', 'Questa proposta è già stata conclusa.')
  }

  if (decision === 'cancel') {
    proposal.status = 'cancelled'
    proposal.finishedAt = Date.now()

    return {
      ok: true,
      intent: 'action-confirmation',
      source: 'tool-fast',
      reply: 'Rinnovo fornitore annullato. Nessuna modifica è stata eseguita.',
      data: {
        type: 'action-confirmation',
        action: {
          actionId: proposal.actionId,
          tool: proposal.tool,
          target: proposal.target,
          subscription: proposal.subscription,
        },
        decision: 'cancel',
        status: 'cancelled',
      },
      meta: buildMeta('action-confirmation', {
        actionId: proposal.actionId,
        actionStatus: 'cancelled',
      }),
    }
  }

  proposal.status = 'executing'

  try {
    const result = await executeFn({
      serviceId: proposal.target.id,
      subscriptionId: proposal.subscription.id,
      mode: proposal.mode,
      expectedStartDate: proposal.expected.startDate,
      expectedEndDate: proposal.expected.endDate,
      newEndDate: proposal.desired.endDate,
      expectedPlanId: proposal.expected.planId,
      expectedDurationMonths: proposal.expected.durationMonths,
      expectedDontRenew: proposal.expected.dontRenew,
      expectedToTransferId: proposal.expected.toTransferId,
      expectedCustomerSubscriptionId: proposal.expected.customerSubscriptionId,
      expectedCustomerEndDate: proposal.expected.customerEndDate,
      actionId: proposal.actionId,
    })

    proposal.status = 'completed'
    proposal.finishedAt = Date.now()

    recentCompletedRenewals.set(fingerprintToken(actorToken), {
      actionId: proposal.actionId,
      target: proposal.target,
      subscription: proposal.subscription,
      completedAt: proposal.finishedAt,
      expiresAt: proposal.finishedAt + CONTEXT_TTL_MS,
    })

    const warningText = result?.warnings?.length
      ? ` Avvisi: ${result.warnings.map(item => item.message || item).join(' ')}`
      : ''

    return {
      ok: true,
      intent: 'action-result',
      source: 'tool-fast',
      reply: `Rinnovo fornitore registrato nel CRM per "${proposal.target.label}". ${
        proposal.subscription.supplierName
      }: ${formatDate(
        result?.subscription?.previousEndDate || proposal.expected.endDate
      )} → ${formatDate(
        result?.subscription?.endsOn || proposal.desired.endDate
      )}. Nessuna operazione è stata eseguita nel portale/API del fornitore, sulla sottoscrizione cliente o su Plesk.${warningText}`,
      data: {
        type: 'action-result',
        action: {
          actionId: proposal.actionId,
          tool: proposal.tool,
          target: proposal.target,
          subscription: proposal.subscription,
          reversible: false,
        },
        result: {
          status: result?.status || 'completed',
          changed: result?.changed !== false,
          idempotent: result?.idempotent === true,
          service: result?.service || null,
          subscription: result?.subscription || null,
          customerSubscriptionUpdated: false,
          pleskUpdated: false,
          externalSupplierUpdated: false,
          warnings: result?.warnings || [],
        },
      },
      meta: buildMeta('action-result', {
        actionId: proposal.actionId,
        actionStatus: 'completed',
        reversible: false,
      }),
    }
  } catch (error) {
    proposal.status = 'failed'
    proposal.finishedAt = Date.now()

    const message = String(error?.message || '')
    const stale = /\(409\)|stato.*cambiato|rispetto all.?anteprima/i.test(message)

    return actionError(
      proposal,
      stale ? 'supplier-renewal-state-changed' : 'supplier-renewal-execution-failed',
      stale
        ? 'Lo stato della sottoscrizione fornitore è cambiato dopo l’anteprima. Il rinnovo non è stato eseguito: ripeti la richiesta.'
        : 'Non è stato possibile registrare il rinnovo fornitore nel CRM. La proposta non verrà eseguita nuovamente.',
      {message}
    )
  }
}

export function getRecentCompletedSupplierRenewalTarget({actorToken = ''} = {}) {
  cleanup()
  return recentCompletedRenewals.get(fingerprintToken(actorToken))?.target || null
}

export function getRecentCompletedSupplierRenewalContext({actorToken = ''} = {}) {
  cleanup()
  return recentCompletedRenewals.get(fingerprintToken(actorToken)) || null
}

export function isRecentCompletedSupplierRenewalUndoRequest(message = '', {actorToken = ''} = {}) {
  cleanup()
  return (
    Boolean(recentCompletedRenewals.get(fingerprintToken(actorToken))) &&
    UNDO_COMPLETED_PATTERN.test(normalizeSearchText(message).trim())
  )
}

export function buildRecentCompletedSupplierRenewalUndoReply({actorToken = ''} = {}) {
  cleanup()
  const recent = recentCompletedRenewals.get(fingerprintToken(actorToken))
  if (!recent) return null

  return {
    ok: true,
    intent: 'action-result',
    source: 'tool-fast',
    reply: `Il rinnovo fornitore di "${recent.target.label}" è già stato registrato nel CRM e non può essere annullato automaticamente dalla chat. Verifica la sottoscrizione e, se serve, modifica esplicitamente la scadenza con una nuova proposta.`,
    data: {
      type: 'action-result',
      action: {
        actionId: recent.actionId,
        tool: TOOL_ID,
        target: recent.target,
        subscription: recent.subscription,
        reversible: false,
      },
      result: {status: 'not-reversible', changed: false},
    },
    meta: buildMeta('action-result', {
      actionId: recent.actionId,
      actionStatus: 'not-reversible',
      reversible: false,
    }),
  }
}
