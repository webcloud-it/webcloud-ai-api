import {createHash, randomUUID} from 'node:crypto'

import {normalizeSearchText} from '../../../utils/text.js'
import {parseServiceListSelector} from './serviceListReferences.js'
import {
  buildRenewalPreviewPayload,
  buildRenewalPreviewReply,
  buildRenewalServiceClarification,
  buildRenewalSubscriptionClarification,
  getRenewalCustomerSubscriptions,
  loadRenewalExternalChecks,
  resolveRenewalServiceTarget,
  resolveRenewalSubscriptionSelection,
} from './renewalPreview.js'
import {renewCustomerSubscription} from './service.js'

const TOOL_ID = 'renewals.renew-subscription'
const PROPOSAL_TTL_MS = 10 * 60 * 1000
const CONTEXT_TTL_MS = 30 * 60 * 1000

const proposals = new Map()
const pendingClarifications = new Map()
const recentCompletedRenewals = new Map()

const DOMAIN_PATTERN =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\b/i

const EXECUTION_REQUEST_PATTERN =
  /\b(?:rinnova|rinnovami|rinnovalo|rinnovala|rinnovare|esegui|eseguire|effettua|effettuare|completa|completare|avvia|avviare|procedi|procedere)\b[\s\S]{0,100}\b(?:rinnovo|servizio|dominio)\b|^\s*rinnova(?:mi|lo|la)?\b/i

const PREVIEW_ONLY_PATTERN =
  /\b(?:anteprima|simula|simulazione|proposta|prepara|preparami|cosa\s+succederebbe|che\s+succede|cosa\s+comporta)\b/i

const LIST_REQUEST_PATTERN =
  /\b(?:tutti|tutte|elenco|lista|servizi|domini|rinnovi)\b[\s\S]{0,80}\b(?:scadono|in\s+scadenza|da\s+rinnovare|rinnovi\s+imminenti)\b/i

const SUPPLIER_RENEWAL_CONTEXT_PATTERN =
  /\b(?:sottoscrizione\s+)?(?:del\s+|della\s+|di\s+)?(?:fornitore|supplier|provider)\b/i

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
    /\b(?:rinnova|rinnovami|rinnovalo|rinnovala)\s+(?:il\s+|lo\s+|la\s+)?(?:servizio\s+|dominio\s+)?(.+)$/i,
    /\b(?:esegui|effettua|completa|avvia|procedi\s+con)\s+(?:il\s+)?rinnovo\s+(?:di|del|della|per)?\s*(.+)$/i,
  ]

  for (const pattern of patterns) {
    const target = cleanNamedTarget(text.match(pattern)?.[1])
    if (target) return target
  }

  return null
}

export function parseRenewalExecutionRequest(message = '') {
  const text = String(message || '').trim()
  const normalized = normalizeSearchText(text)

  if (!normalized || !EXECUTION_REQUEST_PATTERN.test(normalized)) return null
  if (PREVIEW_ONLY_PATTERN.test(normalized) || LIST_REQUEST_PATTERN.test(normalized)) return null
  if (SUPPLIER_RENEWAL_CONTEXT_PATTERN.test(normalized)) return null

  const selector = parseServiceListSelector(text)
  const namedTarget = selector ? null : extractNamedTarget(text)

  return {
    type: 'renewals-renewal-execution-request',
    tool: TOOL_ID,
    message: text,
    selector,
    selectorSource: selector ? 'previous-list' : namedTarget ? 'named-target' : 'context',
    namedTarget,
  }
}

function parseDecision(message = '') {
  const text = normalizeSearchText(message)
    .replace(/[.!?;:]+$/g, '')
    .trim()

  if (CONFIRM_PATTERNS.some(pattern => pattern.test(text))) return 'confirm'
  if (CANCEL_PATTERNS.some(pattern => pattern.test(text))) return 'cancel'
  return null
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('it-IT').format(date)
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

function rememberClarification(actorToken, payload) {
  pendingClarifications.set(fingerprintToken(actorToken), {
    ...payload,
    expiresAt: Date.now() + CONTEXT_TTL_MS,
  })
}

function buildBlockedResult(preview) {
  return {
    ok: true,
    intent: 'action-error',
    source: 'tool-fast',
    reply: [
      buildRenewalPreviewReply(preview),
      '',
      'Il rinnovo reale non può essere eseguito finché i blocchi indicati non vengono risolti.',
    ].join('\n'),
    data: {
      type: 'action-error',
      action: {
        tool: TOOL_ID,
        requiresConfirmation: false,
      },
      preview,
      error: {
        code: 'renewal-preview-blocked',
        details: preview.blockers,
      },
    },
    meta: buildMeta('action-error', {
      actionStatus: 'blocked',
      errorCode: 'renewal-preview-blocked',
    }),
  }
}

export function buildRenewalExecutionProposalFromPreview({
  service,
  customerSubscription,
  preview,
  actorToken = '',
} = {}) {
  cleanup()

  if (!service?.id || !customerSubscription?.id || !preview) {
    return {
      ok: true,
      intent: 'action-error',
      source: 'tool-fast',
      reply: 'Non posso costruire la proposta di rinnovo perché mancano servizio, sottoscrizione o anteprima.',
      data: {
        type: 'action-error',
        error: {code: 'renewal-proposal-incomplete'},
      },
      meta: buildMeta('action-error', {errorCode: 'renewal-proposal-incomplete'}),
    }
  }

  if (preview.status !== 'ready' || preview.blockers?.length) {
    return buildBlockedResult(preview)
  }

  const currentEndDate = preview.customerSubscription.currentEndDate
  const newEndDate = preview.customerSubscription.proposedEndDate

  if (!currentEndDate || !newEndDate) return buildBlockedResult(preview)

  const actionId = randomUUID()
  const now = Date.now()
  const targetLabel = preview.service.domain || preview.service.name || String(service.id)
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
      id: String(customerSubscription.id),
      planId: preview.customerSubscription.plan?.id || null,
      planName: preview.customerSubscription.plan?.name || null,
    },
    expected: {
      startDate: customerSubscription.startsOn || null,
      endDate: currentEndDate,
      planId: preview.customerSubscription.plan?.id || null,
      durationMonths: preview.customerSubscription.plan?.durationMonths || null,
      dontRenew: preview.flags.dontRenew === true,
      toRenew: preview.flags.toRenew === true,
      pleskConnected: preview.plesk.connected === true,
      pleskIntegrationId: preview.plesk.integrationId || null,
    },
    desired: {
      startDate: currentEndDate,
      endDate: newEndDate,
      lastRenewalDate: currentEndDate,
      toRenew: false,
    },
    preview,
  }

  proposals.set(actionId, proposal)

  const warnings = preview.warnings?.length
    ? `\n\nAvvisi: ${preview.warnings.map(item => item.message).join(' ')}`
    : ''

  return {
    ok: true,
    intent: 'action-proposal',
    source: 'tool-fast',
    reply: [
      buildRenewalPreviewReply(preview),
      '',
      `Eseguirò il rinnovo reale portando la scadenza cliente dal ${formatDate(
        currentEndDate
      )} al ${formatDate(newEndDate)}.`,
      preview.plesk.connected
        ? 'La scadenza verrà aggiornata anche su Plesk.'
        : 'Plesk non è collegato: verrà aggiornato soltanto il CRM rinnovi.',
      'Al completamento verrà rimosso il flag DA RINNOVARE. La sottoscrizione fornitore non verrà modificata automaticamente.',
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
        changes: [
          {field: 'subscriptionStartDate', from: proposal.expected.startDate, to: proposal.desired.startDate},
          {field: 'subscriptionEndDate', from: currentEndDate, to: newEndDate},
          {field: 'lastRenewalDate', from: null, to: proposal.desired.lastRenewalDate},
          {field: 'toRenew', from: proposal.expected.toRenew, to: false},
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

async function createProposalForResolved({service, customerSubscription, actorToken, checksLoader}) {
  const checks = await checksLoader(service)
  const preview = buildRenewalPreviewPayload({
    service,
    customerSubscription,
    ...checks,
  })

  return buildRenewalExecutionProposalFromPreview({
    service,
    customerSubscription,
    preview,
    actorToken,
  })
}

async function continueWithService({service, actorToken, checksLoader}) {
  const subscriptions = getRenewalCustomerSubscriptions(service)

  if (!subscriptions.length) {
    const preview = buildRenewalPreviewPayload({service, customerSubscription: null})
    return buildBlockedResult(preview)
  }

  if (subscriptions.length > 1) {
    rememberClarification(actorToken, {
      kind: 'subscription',
      serviceId: String(service.id),
      subscriptionIds: subscriptions.map(item => String(item.id)),
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildRenewalSubscriptionClarification(service, subscriptions).replace(
        'per l’anteprima',
        'per il rinnovo'
      ),
      data: {type: 'clarification', reason: 'renewal-execution-subscription-ambiguous'},
      meta: buildMeta('clarification'),
    }
  }

  return createProposalForResolved({
    service,
    customerSubscription: subscriptions[0],
    actorToken,
    checksLoader,
  })
}

export function hasPendingRenewalExecutionClarification({actorToken = ''} = {}) {
  cleanup()
  return pendingClarifications.has(fingerprintToken(actorToken))
}

export async function handleRenewalExecutionRequest({
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
    return continueWithService({service: resolution.service, actorToken, checksLoader})
  }

  if (resolution.status === 'ambiguous') {
    const candidates = resolution.candidates || []
    rememberClarification(actorToken, {
      kind: 'service',
      serviceIds: candidates.map(item => String(item.id)),
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildRenewalServiceClarification(candidates).replace(
        'Quale vuoi usare?',
        'Quale vuoi rinnovare?'
      ),
      data: {type: 'clarification', reason: 'renewal-execution-service-ambiguous'},
      meta: buildMeta('clarification'),
    }
  }

  return {
    ok: true,
    intent: 'clarification',
    source: 'tool-fast',
    reply:
      resolution.status === 'context-required'
        ? 'Indica quale servizio o dominio vuoi rinnovare, oppure usa un riferimento alla lista precedente.'
        : `Non ho trovato un servizio corrispondente a "${request?.namedTarget || request?.message || ''}".`,
    data: {type: 'clarification', reason: `renewal-execution-${resolution.status || 'not-found'}`},
    meta: buildMeta('clarification'),
  }
}

export async function handlePendingRenewalExecutionClarification({
  message = '',
  services = [],
  actorToken = '',
  checksLoader = loadRenewalExternalChecks,
} = {}) {
  cleanup()

  const key = fingerprintToken(actorToken)
  const pending = pendingClarifications.get(key)
  if (!pending) return null

  if (pending.kind === 'service') {
    const candidates = services.filter(service => pending.serviceIds.includes(String(service?.id)))
    const selector = parseServiceListSelector(message)
    let selected = null

    if (selector?.kind === 'position') {
      const position = selector.position === 'last' ? candidates.length : Number(selector.position)
      if (Number.isInteger(position) && position > 0 && position <= candidates.length) {
        selected = candidates[position - 1]
      }
    }

    if (!selected) {
      const target = normalizeComparable(message)
      const exact = candidates.filter(service => {
        const domain = service?.domains_id?.name || service?.domain?.name || null
        return (
          String(service?.id || '') === String(message || '').trim() ||
          normalizeComparable(service?.name) === target ||
          normalizeComparable(domain) === target
        )
      })
      if (exact.length === 1) selected = exact[0]
    }

    if (!selected) {
      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: buildRenewalServiceClarification(candidates),
        data: {type: 'clarification', reason: 'renewal-execution-service-selection-required'},
        meta: buildMeta('clarification'),
      }
    }

    pendingClarifications.delete(key)
    return continueWithService({service: selected, actorToken, checksLoader})
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
        data: {type: 'clarification', reason: 'renewal-execution-subscription-selection-required'},
        meta: buildMeta('clarification'),
      }
    }

    pendingClarifications.delete(key)
    return createProposalForResolved({
      service,
      customerSubscription: selection.subscription,
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

  return [...proposals.values()]
    .filter(proposal => proposal.actorFingerprint === fingerprint && proposal.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null
}

export function hasRenewalExecutionProposal(actionId = '') {
  cleanup()
  return proposals.has(String(actionId || '').trim())
}

export async function handlePendingRenewalExecutionDecisionMessage({
  message = '',
  actorToken = '',
  executeFn = renewCustomerSubscription,
} = {}) {
  const decision = parseDecision(message)
  if (!decision) return null

  const proposal = getPendingProposalForActor(actorToken)
  if (!proposal) return null

  return handleRenewalExecutionDecision({
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

export async function handleRenewalExecutionDecision({
  action = null,
  actorToken = '',
  executeFn = renewCustomerSubscription,
} = {}) {
  cleanup()

  const actionId = String(action?.actionId || '').trim()
  const decision = String(action?.decision || '').trim().toLowerCase()
  const proposal = proposals.get(actionId)

  if (!proposal) return null

  if (!['confirm', 'cancel'].includes(decision)) {
    return actionError(proposal, 'invalid-decision', 'La decisione deve essere "confirm" oppure "cancel".')
  }

  if (proposal.actorFingerprint !== fingerprintToken(actorToken)) {
    return actionError(proposal, 'action-owner-mismatch', 'Questa proposta appartiene a un’altra sessione.')
  }

  if (proposal.expiresAt <= Date.now()) {
    proposal.status = 'expired'
    proposal.finishedAt = Date.now()
    return actionError(proposal, 'action-expired', 'La proposta è scaduta. Ripeti la richiesta di rinnovo.')
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
      reply: 'Rinnovo annullato. Nessuna modifica è stata eseguita.',
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
      expectedStartDate: proposal.expected.startDate,
      expectedEndDate: proposal.expected.endDate,
      newEndDate: proposal.desired.endDate,
      expectedPlanId: proposal.expected.planId,
      expectedDurationMonths: proposal.expected.durationMonths,
      expectedDontRenew: proposal.expected.dontRenew,
      expectedToRenew: proposal.expected.toRenew,
      expectedPleskConnected: proposal.expected.pleskConnected,
      expectedPleskIntegrationId: proposal.expected.pleskIntegrationId,
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

    const pleskText = result?.plesk?.required
      ? result.plesk.updated
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
      reply: `Rinnovo completato per "${proposal.target.label}". Scadenza cliente: ${formatDate(
        result?.subscription?.previousEndDate || proposal.expected.endDate
      )} → ${formatDate(result?.subscription?.endsOn || proposal.desired.endDate)}. ${pleskText} Il flag DA RINNOVARE è stato rimosso.${warningText}`,
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
          plesk: result?.plesk || null,
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
    const partial = /partial|parziale|compensazione fallita/i.test(message)

    return actionError(
      proposal,
      partial ? 'renewal-partial-failure' : stale ? 'renewal-state-changed' : 'renewal-execution-failed',
      partial
        ? 'Il rinnovo non è stato completato in modo coerente tra CRM e Plesk. È necessario verificare manualmente entrambi i sistemi prima di riprovare.'
        : stale
          ? 'Lo stato del servizio è cambiato dopo l’anteprima. Il rinnovo non è stato eseguito: ripeti la richiesta.'
          : 'Non è stato possibile completare il rinnovo. La proposta non verrà eseguita nuovamente.',
      {message}
    )
  }
}

export function getRecentCompletedRenewalTarget({actorToken = ''} = {}) {
  cleanup()

  const recent = recentCompletedRenewals.get(fingerprintToken(actorToken))

  return recent?.target || null
}

export function getRecentCompletedRenewalContext({actorToken = ''} = {}) {
  cleanup()
  return recentCompletedRenewals.get(fingerprintToken(actorToken)) || null
}

export function isRecentCompletedRenewalUndoRequest(message = '', {actorToken = ''} = {}) {
  cleanup()
  return Boolean(recentCompletedRenewals.get(fingerprintToken(actorToken))) && UNDO_COMPLETED_PATTERN.test(
    normalizeSearchText(message).trim()
  )
}

export function buildRecentCompletedRenewalUndoReply({actorToken = ''} = {}) {
  cleanup()
  const recent = recentCompletedRenewals.get(fingerprintToken(actorToken))
  if (!recent) return null

  return {
    ok: true,
    intent: 'action-result',
    source: 'tool-fast',
    reply: `Il rinnovo di "${recent.target.label}" è già stato eseguito e coinvolge dati di rinnovo e, quando applicabile, Plesk. Non può essere annullato automaticamente dalla chat. Verifica CRM e Plesk e, se serve, modifica esplicitamente la scadenza con una nuova proposta.`,
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
