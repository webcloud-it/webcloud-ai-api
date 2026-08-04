import {createHash, randomUUID} from 'node:crypto'

import {normalizeSearchText} from '../../../utils/text.js'
import {resolveServiceListReference} from './serviceListReferences.js'
import {
  buildFullRenewalCustomerClarification,
  buildFullRenewalPreviewForSelection,
  buildFullRenewalPreviewReply,
  buildFullRenewalServiceClarification,
  buildFullRenewalSupplierClarification,
  getFullRenewalSupplierCandidates,
  isFullRenewalPreviewOnlyRequest,
  parseFullRenewalBaseRequest,
  parseFullRenewalClarificationSelector,
  resolveFullRenewalSupplierSelection,
} from './fullRenewalPreview.js'
import {
  getRenewalCustomerSubscriptions,
  loadRenewalExternalChecks,
  resolveRenewalServiceTarget,
  resolveRenewalSubscriptionSelection,
} from './renewalPreview.js'
import {renewFullService} from './service.js'

const TOOL_ID = 'renewals.renew-full-service'
const PROPOSAL_TTL_MS = 10 * 60 * 1000
const CONTEXT_TTL_MS = 30 * 60 * 1000

const proposals = new Map()
const pendingClarifications = new Map()
const recentCompletedRenewals = new Map()

const EXECUTION_PATTERN =
  /\b(?:rinnova|rinnovami|rinnovare|esegui|eseguire|effettua|effettuare|completa|completare|avvia|avviare|procedi|procedere)\b/i

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
            subscriptions: proposal.subscriptions,
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

export function parseFullRenewalExecutionRequest(message = '') {
  const text = String(message || '').trim()
  const normalized = normalizeSearchText(text)

  if (!normalized || !EXECUTION_PATTERN.test(normalized)) return null
  if (isFullRenewalPreviewOnlyRequest(normalized)) return null

  const request = parseFullRenewalBaseRequest(text)
  return request
    ? {
        ...request,
        type: 'renewals-full-renewal-execution-request',
        tool: TOOL_ID,
      }
    : null
}

function buildBlockedResult(preview) {
  return {
    ok: true,
    intent: 'action-error',
    source: 'tool-fast',
    reply: [
      buildFullRenewalPreviewReply(preview),
      '',
      'Il rinnovo completo non può essere eseguito finché i blocchi indicati non vengono risolti.',
    ].join('\n'),
    data: {
      type: 'action-error',
      action: {tool: TOOL_ID, requiresConfirmation: false},
      preview,
      error: {
        code: 'full-renewal-preview-blocked',
        details: preview.blockers || [],
      },
    },
    meta: buildMeta('action-error', {
      actionStatus: 'blocked',
      errorCode: 'full-renewal-preview-blocked',
    }),
  }
}

export function buildFullRenewalExecutionProposalFromPreview({
  service,
  customerSubscription,
  supplierCandidate,
  preview,
  actorToken = '',
} = {}) {
  cleanup()

  const supplierSubscription = supplierCandidate?.subscription || null
  const linkedCustomerSubscription =
    supplierCandidate?.customerSubscription || customerSubscription || null

  if (
    !service?.id ||
    !customerSubscription?.id ||
    !supplierSubscription?.id ||
    !preview
  ) {
    return actionError(
      null,
      'full-renewal-proposal-incomplete',
      'Non posso costruire la proposta di rinnovo completo perché mancano servizio o sottoscrizioni.'
    )
  }

  if (preview.status !== 'ready' || preview.blockers?.length) {
    return buildBlockedResult(preview)
  }

  const customerPreview = preview.customerRenewal?.customerSubscription || {}
  const supplierPreview = preview.supplierRenewal?.supplierSubscription || {}

  if (
    !customerPreview.currentEndDate ||
    !customerPreview.proposedEndDate ||
    !supplierPreview.currentEndDate ||
    !supplierPreview.proposedEndDate
  ) {
    return buildBlockedResult(preview)
  }

  const actionId = randomUUID()
  const now = Date.now()
  const targetLabel = preview.service?.domain || preview.service?.name || String(service.id)
  const toTransfer = service?.toTransfer || service?.to_transfer || null
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
    subscriptions: {
      customer: {
        id: String(customerSubscription.id),
        planId: customerPreview.plan?.id || null,
        planName: customerPreview.plan?.name || null,
      },
      supplier: {
        id: String(supplierSubscription.id),
        planId: supplierPreview.plan?.id || null,
        planName: supplierPreview.plan?.name || null,
        supplierId: supplierPreview.plan?.supplier?.id || null,
        supplierName: supplierPreview.plan?.supplier?.name || null,
      },
    },
    expected: {
      dontRenew: preview.flags?.dontRenew === true,
      toTransferId:
        typeof toTransfer === 'object' ? toTransfer?.id || null : toTransfer || null,
      customer: {
        startDate: customerSubscription.startsOn || null,
        endDate: customerPreview.currentEndDate,
        planId: customerPreview.plan?.id || null,
        durationMonths: customerPreview.plan?.durationMonths || null,
        toRenew: preview.flags?.toRenew === true,
        pleskConnected: preview.plesk?.connected === true,
        pleskIntegrationId: preview.plesk?.integrationId || null,
      },
      supplier: {
        startDate: supplierSubscription.startsOn || null,
        endDate: supplierPreview.currentEndDate,
        planId: supplierPreview.plan?.id || null,
        durationMonths: supplierPreview.plan?.durationMonths || null,
        customerSubscriptionId: linkedCustomerSubscription?.id || null,
        customerEndDate: linkedCustomerSubscription?.endsOn || null,
      },
    },
    desired: {
      customerEndDate: customerPreview.proposedEndDate,
      supplierEndDate: supplierPreview.proposedEndDate,
      toRenew: false,
    },
    preview,
  }

  proposals.set(actionId, proposal)

  return {
    ok: true,
    intent: 'action-proposal',
    source: 'tool-fast',
    reply: buildFullRenewalPreviewReply(preview, {
      includePreviewDisclaimer: false,
      includeConfirmationPrompt: true,
    }),
    data: {
      type: 'action-preview',
      action: {
        actionId,
        tool: TOOL_ID,
        requiresConfirmation: true,
        reversible: false,
        expiresAt: new Date(proposal.expiresAt).toISOString(),
        target: proposal.target,
        subscriptions: proposal.subscriptions,
        changes: [
          {
            field: 'supplierSubscriptionEndDate',
            from: proposal.expected.supplier.endDate,
            to: proposal.desired.supplierEndDate,
          },
          {
            field: 'customerSubscriptionEndDate',
            from: proposal.expected.customer.endDate,
            to: proposal.desired.customerEndDate,
          },
          {
            field: 'toRenew',
            from: proposal.expected.customer.toRenew,
            to: false,
          },
        ],
      },
      preview,
    },
    meta: buildMeta('action-proposal', {
      actionId,
      actionStatus: 'pending',
      reversible: false,
    }),
  }
}

function storeClarification(actorToken = '', payload = {}) {
  pendingClarifications.set(fingerprintToken(actorToken), {
    ...payload,
    expiresAt: Date.now() + CONTEXT_TTL_MS,
  })
}

async function createProposalForSelection({
  service,
  customerSubscription,
  supplierCandidate,
  actorToken,
  checksLoader,
}) {
  const preview = await buildFullRenewalPreviewForSelection({
    service,
    customerSubscription,
    supplierCandidate,
    checksLoader,
  })

  return buildFullRenewalExecutionProposalFromPreview({
    service,
    customerSubscription,
    supplierCandidate,
    preview,
    actorToken,
  })
}

async function continueWithCustomer({
  service,
  customerSubscription,
  actorToken,
  checksLoader,
}) {
  const candidates = getFullRenewalSupplierCandidates(service, customerSubscription)

  if (!candidates.length) {
    const preview = await buildFullRenewalPreviewForSelection({
      service,
      customerSubscription,
      supplierCandidate: null,
      checksLoader,
    })
    return buildBlockedResult(preview)
  }

  if (candidates.length > 1) {
    storeClarification(actorToken, {
      kind: 'supplier-subscription',
      serviceId: String(service.id),
      customerSubscriptionId: String(customerSubscription.id),
      supplierSubscriptionIds: candidates.map(candidate => String(candidate?.subscription?.id)),
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildFullRenewalSupplierClarification(service, candidates),
      data: {type: 'clarification', reason: 'full-renewal-supplier-subscription-ambiguous'},
      meta: buildMeta('clarification'),
    }
  }

  return createProposalForSelection({
    service,
    customerSubscription,
    supplierCandidate: candidates[0],
    actorToken,
    checksLoader,
  })
}

async function continueWithService({service, actorToken, checksLoader}) {
  const subscriptions = getRenewalCustomerSubscriptions(service)

  if (!subscriptions.length) {
    const preview = await buildFullRenewalPreviewForSelection({
      service,
      customerSubscription: null,
      supplierCandidate: null,
      checksLoader,
    })
    return buildBlockedResult(preview)
  }

  if (subscriptions.length > 1) {
    storeClarification(actorToken, {
      kind: 'customer-subscription',
      serviceId: String(service.id),
      customerSubscriptionIds: subscriptions.map(item => String(item.id)),
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildFullRenewalCustomerClarification(service, subscriptions),
      data: {type: 'clarification', reason: 'full-renewal-customer-subscription-ambiguous'},
      meta: buildMeta('clarification'),
    }
  }

  return continueWithCustomer({
    service,
    customerSubscription: subscriptions[0],
    actorToken,
    checksLoader,
  })
}

export function hasPendingFullRenewalExecutionClarification({actorToken = ''} = {}) {
  cleanup()
  return pendingClarifications.has(fingerprintToken(actorToken))
}

export async function handleFullRenewalExecutionRequest({
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
    recentServiceId,
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
      meta: buildMeta('clarification'),
    }
  }

  if (resolution.status !== 'resolved') {
    return actionError(
      null,
      `full-renewal-${resolution.status || 'not-found'}`,
      resolution.status === 'context-required'
        ? 'Indica quale servizio o dominio vuoi rinnovare completamente, oppure usa un riferimento alla lista precedente.'
        : `Non ho trovato un servizio corrispondente a "${request?.namedTarget || request?.message || ''}".`
    )
  }

  return continueWithService({
    service: resolution.service,
    actorToken,
    checksLoader,
  })
}

export async function handlePendingFullRenewalExecutionClarification({
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
        : candidates.find(
            item => normalizeSearchText(item?.name) === normalizeSearchText(message)
          )

    if (!selected) {
      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: buildFullRenewalServiceClarification(candidates),
        data: {type: 'clarification', reason: 'full-renewal-service-selection-invalid'},
        meta: buildMeta('clarification'),
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
        meta: buildMeta('clarification'),
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
        meta: buildMeta('clarification'),
      }
    }

    pendingClarifications.delete(key)
    return createProposalForSelection({
      service,
      customerSubscription,
      supplierCandidate: resolved.candidate,
      actorToken,
      checksLoader,
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

export function hasFullRenewalExecutionProposal(actionId = '') {
  cleanup()
  return proposals.has(String(actionId || '').trim())
}

export async function handlePendingFullRenewalExecutionDecisionMessage({
  message = '',
  actorToken = '',
  executeFn = renewFullService,
} = {}) {
  const decision = parseDecision(message)
  if (!decision) return null

  const proposal = getPendingProposalForActor(actorToken)
  if (!proposal) return null

  return handleFullRenewalExecutionDecision({
    action: {actionId: proposal.actionId, decision},
    actorToken,
    executeFn,
  })
}

export async function handleFullRenewalExecutionDecision({
  action = null,
  actorToken = '',
  executeFn = renewFullService,
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
      'La proposta è scaduta. Ripeti la richiesta di rinnovo completo.'
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
      reply: 'Rinnovo completo annullato. Nessuna modifica è stata eseguita.',
      data: {
        type: 'action-confirmation',
        action: {
          actionId: proposal.actionId,
          tool: proposal.tool,
          target: proposal.target,
          subscriptions: proposal.subscriptions,
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
      customer: {
        subscriptionId: proposal.subscriptions.customer.id,
        expectedStartDate: proposal.expected.customer.startDate,
        expectedEndDate: proposal.expected.customer.endDate,
        newEndDate: proposal.desired.customerEndDate,
        expectedPlanId: proposal.expected.customer.planId,
        expectedDurationMonths: proposal.expected.customer.durationMonths,
        expectedToRenew: proposal.expected.customer.toRenew,
        expectedPleskConnected: proposal.expected.customer.pleskConnected,
        expectedPleskIntegrationId: proposal.expected.customer.pleskIntegrationId,
      },
      supplier: {
        subscriptionId: proposal.subscriptions.supplier.id,
        mode: 'renew-by-plan-duration',
        expectedStartDate: proposal.expected.supplier.startDate,
        expectedEndDate: proposal.expected.supplier.endDate,
        newEndDate: proposal.desired.supplierEndDate,
        expectedPlanId: proposal.expected.supplier.planId,
        expectedDurationMonths: proposal.expected.supplier.durationMonths,
        expectedToTransferId: proposal.expected.toTransferId,
        expectedCustomerSubscriptionId:
          proposal.expected.supplier.customerSubscriptionId,
        expectedCustomerEndDate: proposal.expected.supplier.customerEndDate,
      },
      expectedDontRenew: proposal.expected.dontRenew,
      actionId: proposal.actionId,
    })

    proposal.status = 'completed'
    proposal.finishedAt = Date.now()

    recentCompletedRenewals.set(fingerprintToken(actorToken), {
      actionId: proposal.actionId,
      target: proposal.target,
      subscriptions: proposal.subscriptions,
      completedAt: proposal.finishedAt,
      expiresAt: proposal.finishedAt + CONTEXT_TTL_MS,
    })

    const customerEnd = result?.customer?.subscription?.endsOn || proposal.desired.customerEndDate
    const supplierEnd = result?.supplier?.subscription?.endsOn || proposal.desired.supplierEndDate
    const pleskText = result?.customer?.plesk?.required
      ? result.customer.plesk.updated
        ? 'Plesk è stato aggiornato.'
        : 'Plesk non risulta aggiornato.'
      : 'Plesk non era applicabile.'
    const warningText = result?.warnings?.length
      ? ` Avvisi: ${result.warnings.map(item => item.message || item).join(' ')}`
      : ''

    return {
      ok: true,
      intent: 'action-result',
      source: 'tool-fast',
      reply: `Rinnovo completo concluso per "${proposal.target.label}". Scadenza fornitore: ${formatDate(
        proposal.expected.supplier.endDate
      )} → ${formatDate(supplierEnd)}. Scadenza cliente: ${formatDate(
        proposal.expected.customer.endDate
      )} → ${formatDate(customerEnd)}. ${pleskText} Il flag DA RINNOVARE è stato rimosso. Nessun ordine è stato eseguito nel portale/API del fornitore.${warningText}`,
      data: {
        type: 'action-result',
        action: {
          actionId: proposal.actionId,
          tool: proposal.tool,
          target: proposal.target,
          subscriptions: proposal.subscriptions,
          reversible: false,
        },
        result: {
          status: result?.status || 'completed',
          changed: result?.changed !== false,
          idempotent: result?.idempotent === true,
          service: result?.service || null,
          customer: result?.customer || null,
          supplier: result?.supplier || null,
          steps: result?.steps || [],
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
    const partial = /partial|parziale|compensazione fallita|verificare manualmente/i.test(message)

    return actionError(
      proposal,
      partial
        ? 'full-renewal-partial-failure'
        : stale
          ? 'full-renewal-state-changed'
          : 'full-renewal-execution-failed',
      partial
        ? 'Il rinnovo completo non è terminato in modo coerente. Verifica manualmente sottoscrizione fornitore, sottoscrizione cliente e Plesk prima di riprovare.'
        : stale
          ? 'Lo stato del servizio è cambiato dopo l’anteprima. Il rinnovo completo non è stato eseguito: ripeti la richiesta.'
          : 'Non è stato possibile completare il rinnovo. Le compensazioni disponibili sono state tentate e la proposta non verrà eseguita nuovamente.',
      {message}
    )
  }
}

export function getRecentCompletedFullRenewalTarget({actorToken = ''} = {}) {
  cleanup()
  return recentCompletedRenewals.get(fingerprintToken(actorToken))?.target || null
}

export function getRecentCompletedFullRenewalContext({actorToken = ''} = {}) {
  cleanup()
  return recentCompletedRenewals.get(fingerprintToken(actorToken)) || null
}

export function isRecentCompletedFullRenewalUndoRequest(message = '', {actorToken = ''} = {}) {
  cleanup()
  return (
    Boolean(recentCompletedRenewals.get(fingerprintToken(actorToken))) &&
    UNDO_COMPLETED_PATTERN.test(normalizeSearchText(message).trim())
  )
}

export function buildRecentCompletedFullRenewalUndoReply({actorToken = ''} = {}) {
  cleanup()
  const recent = recentCompletedRenewals.get(fingerprintToken(actorToken))
  if (!recent) return null

  return {
    ok: true,
    intent: 'action-result',
    source: 'tool-fast',
    reply: `Il rinnovo completo di "${recent.target.label}" è già stato eseguito e può aver coinvolto sottoscrizione fornitore, sottoscrizione cliente e Plesk. Non può essere annullato automaticamente dalla chat. Verifica i sistemi e, se necessario, prepara modifiche esplicite delle singole scadenze.`,
    data: {
      type: 'action-result',
      action: {
        actionId: recent.actionId,
        tool: TOOL_ID,
        target: recent.target,
        subscriptions: recent.subscriptions,
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
