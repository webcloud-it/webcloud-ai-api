import {createHash, randomUUID} from 'node:crypto'

import {normalizeSearchText} from '../../../utils/text.js'
import {buildServiceListPayload} from './serviceQueries.js'
import {parseServiceListSelector, resolveServiceListReference} from './serviceListReferences.js'
import {pickPreviousServiceListState} from './serviceListState.js'
import {updateServiceFlags} from './service.js'

const TOOL_ID = 'renewals.update-service-flags'
const PROPOSAL_TTL_MS = 10 * 60 * 1000
const proposals = new Map()
const pendingClarifications = new Map()
const ACTION_CONTEXT_TTL_MS = 30 * 60 * 1000
const recentActionContexts = new Map()

const CONFIRM_ACTION_PATTERNS = [
  /^(?:si|sì|certo|certamente|confermo|conferma|confermato|ok|okay|va bene|d['’]?accordo)$/i,
  /^(?:procedi|procedi pure|vai|vai pure|avanti|continua|fallo|fai pure|esegui|esegui pure|applica|applicalo|salva)$/i,
  /^(?:si|sì)[,\s]+(?:confermo|procedi|procedi pure|vai|vai pure|fallo|esegui|applica|ok|va bene)$/i,
]

const CANCEL_ACTION_PATTERNS = [
  /^(?:no|annulla|annullo|cancella|stop|ferma|fermati|blocca|abortisci|interrompi|niente|ripristina|ripristino|undo|revert)$/i,
  /^(?:lascia stare|lascia perdere|come non detto|non procedere|non continuare|non farlo|non eseguire|non applicare)$/i,
  /^(?:no)[,\s]+(?:annulla|cancella|ferma|non procedere|non farlo|lascia stare|lascia perdere)$/i,
  /^(?:annulla|cancella|revoca)\s+(?:questa|la)\s+(?:proposta|operazione|modifica|azione)$/i,
  /^(?:torna|torniamo|vai)\s+indietro$/i,
  /^(?:fai|facciamo)\s+(?:un\s+passo\s+indietro|marcia\s+indietro)$/i,
  /^(?:rimetti|riporta|ripristina)\s+(?:tutto\s+)?(?:com['’]era|come\s+prima|allo\s+stato\s+precedente)$/i,
]

const UNDO_COMPLETED_ACTION_PATTERNS = [
  /^(?:annulla|annullo|undo|revert|ripristina|ripristino|revoca|revoco)$/i,
  /^(?:annulla|annullo|cancella|revoca|ritira)\s+(?:l['’]?\s*)?(?:ultima|scorsa|precedente)\s+(?:operazione|azione|modifica)$/i,
  /^(?:annulla|annullo|cancella|revoca)\s+(?:la|questa)\s+(?:operazione|azione|modifica)(?:\s+appena\s+(?:fatta|eseguita))?$/i,
  /^(?:torna|torniamo|vai)\s+indietro$/i,
  /^(?:fai|facciamo)\s+(?:un\s+passo\s+indietro|marcia\s+indietro)$/i,
  /^(?:rimetti|riporta|ripristina)\s+(?:tutto\s+)?(?:com['’]era|come\s+prima|allo\s+stato\s+precedente|alla\s+situazione\s+precedente)$/i,
  /^(?:rimetti|riporta|ripristina)(?:lo|la)?\s+(?:com['’]era|come\s+prima|allo\s+stato\s+precedente)$/i,
  /^(?:voglio|vorrei)\s+(?:annullare|cancellare|revocare|ripristinare)\s+(?:l['’]?\s*)?(?:ultima|scorsa|precedente)?\s*(?:operazione|azione|modifica)?$/i,
  /^(?:non\s+va\s+bene|ho\s+sbagliato|errore|sbagliato)[,\s]*(?:annulla|torna\s+indietro|ripristina|rimetti\s+com['’]era)?$/i,
]

const SET_ACTION_VERBS_PATTERN =
  '(?:segna|segnalo|segnala|marca|marcalo|marcala|imposta|impostalo|impostala|attiva|attivalo|attivala|abilita|abilitalo|abilitala|accendi|accendilo|accendila|aggiungi|aggiungilo|aggiungila|metti|mettilo|mettila|porta|portalo|portala|passa|passalo|passala|sposta|spostalo|spostala|seleziona|selezionalo|selezionala|spunta|spuntalo|spuntala|applica|applicalo|applicala|assegna|assegnalo|assegnala)'

const REMOVE_ACTION_VERBS_PATTERN =
  '(?:rimuovi|rimuovilo|rimuovila|togli|toglilo|toglila|disattiva|disattivalo|disattivala|disabilita|disabilitalo|disabilitala|spegni|spegnilo|spegnila|annulla|annullalo|annullala|leva|levalo|levala|elimina|eliminalo|eliminala|cancella|cancellalo|cancellala|revoca|revocalo|revocala|deseleziona|deselezionalo|deselezionala|smarca|smarcalo|smarcala|azzera|azzeralo|azzerala|resetta|resettalo|resettala)'

const CONTEXTUAL_ACTION_WORDS_PATTERN =
  /\b(?:ora|adesso|adesso invece|poi|quindi|allora|a questo punto|successivamente|dopodiché|dopodiche|invece|anche|lo|la|lui|questo|questa|quello|quella|quest['’]ultimo|quest['’]ultima|lo stesso|la stessa|il medesimo|la medesima|il servizio|quel servizio|questo servizio|il dominio|quel dominio|questo dominio|come|con|in|su|a|al|nel|tra|fra|da|dal|dalla|il|lo|la|un|una|flag|stato|voce)\b/gi

function createServiceFlagAction({field, label, termPattern}) {
  const term = `(?:${termPattern.source})`

  return {
    field,
    label,
    termPattern,

    setPatterns: [
      new RegExp(`\\b${SET_ACTION_VERBS_PATTERN}\\b[\\s\\S]{0,140}${term}`, 'i'),
      new RegExp(`${term}[\\s\\S]{0,100}\\b${SET_ACTION_VERBS_PATTERN}\\b`, 'i'),
    ],

    removePatterns: [
      new RegExp(`\\b${REMOVE_ACTION_VERBS_PATTERN}\\b[\\s\\S]{0,140}${term}`, 'i'),
      new RegExp(`${term}[\\s\\S]{0,100}\\b${REMOVE_ACTION_VERBS_PATTERN}\\b`, 'i'),
    ],

    setTargetPatterns: [
      new RegExp(
        `\\b${SET_ACTION_VERBS_PATTERN}\\s+(?:(?:il|lo|la)\\s+)?(?:flag\\s+|stato\\s+)?${term}\\s+(?:su|per|a|al|sul|nel)\\s+(.+)$`,
        'i'
      ),
      new RegExp(
        `\\b${SET_ACTION_VERBS_PATTERN}\\s+(?:il\\s+|lo\\s+|la\\s+)?(?:servizio\\s+|dominio\\s+)?(.+?)\\s+(?:come\\s+|con\\s+|in\\s+|su\\s+|per\\s+)?${term}`,
        'i'
      ),
    ],

    removeTargetPatterns: [
      new RegExp(
        `\\b${REMOVE_ACTION_VERBS_PATTERN}\\s+(?:il\\s+flag\\s+|lo\\s+stato\\s+)?${term}\\s+(?:da|dal|dalla|su|per|a)\\s+(.+)$`,
        'i'
      ),
      new RegExp(
        `\\b${REMOVE_ACTION_VERBS_PATTERN}\\s+(?:da\\s+)?(?:il\\s+|lo\\s+|la\\s+)?(?:servizio\\s+|dominio\\s+)?(.+?)\\s+(?:dal\\s+|dalla\\s+|da\\s+|in\\s+)?${term}`,
        'i'
      ),
    ],
  }
}

const SERVICE_FLAG_ACTIONS = [
  createServiceFlagAction({
    field: 'dontRenew',
    label: 'NON RINNOVARE',
    termPattern:
      /\b(?:da\s+)?non\s+rinnovare\b|\bnon\s+rinnovo\b|\bno\s+rinnovo\b|\bstop\s+rinnovo\b|\brinnovo\s+escluso\b|\bda\s+escludere\s+dal\s+rinnovo\b|\bdont[_ -]?renew\b/i,
  }),

  createServiceFlagAction({
    field: 'autoRenew',
    label: 'RINNOVO AUTOMATICO',
    termPattern:
      /\brinnovo\s+automatico\b|\brinnovo\s+auto\b|\bauto\s*rinnovo\b|\bautorinnovo\b|\bautomatic\s+renewal\b|\bauto[_ -]?renew\b/i,
  }),

  createServiceFlagAction({
    field: 'toRenew',
    label: 'DA RINNOVARE',
    termPattern:
      /\bda\s+rinnovare\b|\bper\s+il\s+rinnovo\b|\bin\s+rinnovo\b|\btra\s+i\s+rinnovi\b|\bfra\s+i\s+rinnovi\b|\bto[_ -]?renew\b/i,
  }),
]

function cleanupProposals(now = Date.now()) {
  for (const [actionId, proposal] of proposals.entries()) {
    const finishedAt = proposal.finishedAt || proposal.expiresAt

    if (
      proposal.expiresAt <= now ||
      (proposal.status !== 'pending' && finishedAt + PROPOSAL_TTL_MS <= now)
    ) {
      proposals.delete(actionId)
    }
  }
}

function cleanupPendingClarifications(now = Date.now()) {
  for (const [actorFingerprint, pending] of pendingClarifications.entries()) {
    if (!pending || pending.expiresAt <= now) {
      pendingClarifications.delete(actorFingerprint)
    }
  }
}

function cleanupRecentActionContexts(now = Date.now()) {
  for (const [actorFingerprint, context] of recentActionContexts.entries()) {
    if (!context || context.expiresAt <= now) {
      recentActionContexts.delete(actorFingerprint)
    }
  }
}

function fingerprintToken(token = '') {
  return createHash('sha256')
    .update(String(token || ''))
    .digest('hex')
    .slice(0, 24)
}

function getRecentActionContext(actorToken = '') {
  cleanupRecentActionContexts()

  return recentActionContexts.get(fingerprintToken(actorToken)) || null
}

function rememberRecentActionTarget(actorToken = '', target = null) {
  if (!target?.id) return

  const actorFingerprint = fingerprintToken(actorToken)

  const existing = recentActionContexts.get(actorFingerprint) || {}

  recentActionContexts.set(actorFingerprint, {
    ...existing,

    target: {
      type: 'service',
      id: String(target.id),
      label: target.label || String(target.id),
    },

    expiresAt: Date.now() + ACTION_CONTEXT_TTL_MS,
  })
}

function rememberCompletedAction(actorToken = '', proposal = null) {
  if (!proposal?.target?.id || proposal?.kind === 'undo') {
    return
  }

  const actorFingerprint = fingerprintToken(actorToken)

  recentActionContexts.set(actorFingerprint, {
    target: {
      type: 'service',
      id: String(proposal.target.id),
      label: proposal.target.label || String(proposal.target.id),
    },

    lastCompleted: {
      actionId: proposal.actionId,
      target: proposal.target,

      changes: proposal.changes.map(change => ({...change})),

      beforeFlags: {
        ...proposal.expectedFlags,
      },

      afterFlags: {
        ...proposal.desiredFlags,
      },

      completedAt: proposal.finishedAt || Date.now(),

      undoneAt: null,
    },

    expiresAt: Date.now() + ACTION_CONTEXT_TTL_MS,
  })
}

function markCompletedActionAsUndone(actorToken = '', undoProposal = null) {
  const actorFingerprint = fingerprintToken(actorToken)

  const context = recentActionContexts.get(actorFingerprint)

  if (!context?.lastCompleted || context.lastCompleted.actionId !== undoProposal?.undoOfActionId) {
    return
  }

  recentActionContexts.set(actorFingerprint, {
    ...context,

    target: undoProposal.target,

    lastCompleted: {
      ...context.lastCompleted,
      undoneAt: Date.now(),
    },

    expiresAt: Date.now() + ACTION_CONTEXT_TTL_MS,
  })
}

function normalizeActionDecisionMessage(message = '') {
  return String(message || '')
    .toLowerCase()
    .trim()
    .replace(/[.!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
}

function parseActionDecisionMessage(message = '') {
  const normalized = normalizeActionDecisionMessage(message)

  if (!normalized) return null

  if (CONFIRM_ACTION_PATTERNS.some(pattern => pattern.test(normalized))) {
    return 'confirm'
  }

  if (CANCEL_ACTION_PATTERNS.some(pattern => pattern.test(normalized))) {
    return 'cancel'
  }

  return null
}

function auditAction(event, proposal, extra = {}) {
  console.info(
    '[renewals-action-audit]',
    JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      actionId: proposal?.actionId || null,
      actor: proposal?.actorFingerprint || null,
      tool: proposal?.tool || TOOL_ID,
      target: proposal?.target || null,
      changes: proposal?.changes || null,
      ...extra,
    })
  )
}

function getPendingProposalForActor(actorToken = '') {
  cleanupProposals()

  const actorFingerprint = fingerprintToken(actorToken)

  const matching = [...proposals.values()]
    .filter(proposal => {
      return (
        proposal?.actorFingerprint === actorFingerprint &&
        proposal?.status === 'pending' &&
        proposal?.expiresAt > Date.now()
      )
    })
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))

  return matching[0] || null
}

function supersedePendingProposals(actorFingerprint) {
  const now = Date.now()

  for (const proposal of proposals.values()) {
    if (proposal?.actorFingerprint === actorFingerprint && proposal?.status === 'pending') {
      proposal.status = 'superseded'
      proposal.finishedAt = now

      auditAction('superseded', proposal)
    }
  }
}

function hasAnyPattern(message, patterns) {
  return patterns.some(pattern => pattern.test(message))
}

function cleanTarget(value = '') {
  return String(value || '')
    .replace(/^[\s:,-]+|[\s?.!,;:,-]+$/g, '')
    .replace(/^(?:il|lo|la|i|gli|le|un|una)\s+/i, '')
    .replace(/^(?:servizio|dominio)\s+/i, '')
    .trim()
}

function isImplicitActionTarget(message = '', config = null, desiredValue = true) {
  if (!config?.termPattern) return false

  let remainder = normalizeSearchText(message)

  remainder = remainder
    .replace(config.termPattern, ' ')
    .replace(
      new RegExp(
        `\\b${desiredValue ? SET_ACTION_VERBS_PATTERN : REMOVE_ACTION_VERBS_PATTERN}\\b`,
        'gi'
      ),
      ' '
    )
    .replace(CONTEXTUAL_ACTION_WORDS_PATTERN, ' ')
    .replace(/[.,!?;:'"“”()[\]{}_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return !remainder
}

function extractNamedTarget(message = '', config = null, desiredValue = true) {
  const text = String(message || '').trim()
  const quoted = text.match(/["“”']([^"“”']{2,})["“”']/)

  if (quoted?.[1] && !config?.termPattern?.test(normalizeSearchText(quoted[1]))) {
    return cleanTarget(quoted[1])
  }

  if (isImplicitActionTarget(text, config, desiredValue)) {
    return null
  }

  const patterns = desiredValue
    ? config?.setTargetPatterns || []
    : config?.removeTargetPatterns || []

  for (const pattern of patterns) {
    const match = text.match(pattern)
    const target = cleanTarget(match?.[1])

    if (target) {
      return target
    }
  }

  return null
}

function getServiceFlagActionConfig(field) {
  return SERVICE_FLAG_ACTIONS.find(config => config.field === field) || null
}

export function parseServiceFlagAction(message = '') {
  const normalized = normalizeSearchText(message)

  if (!normalized) {
    return null
  }

  for (const config of SERVICE_FLAG_ACTIONS) {
    if (!config.termPattern.test(normalized)) {
      continue
    }

    const remove = hasAnyPattern(normalized, config.removePatterns)
    const set = hasAnyPattern(normalized, config.setPatterns)

    if (remove === set) {
      continue
    }

    const selector = parseServiceListSelector(message)
    const desiredValue = set

    const namedTarget = selector ? null : extractNamedTarget(message, config, desiredValue)

    return {
      type: 'renewals-action-request',
      tool: TOOL_ID,
      message: String(message || '').trim(),
      field: config.field,
      label: config.label,
      desiredValue,
      selector,
      selectorSource: selector ? 'previous-list' : namedTarget ? 'named-target' : 'context',
      namedTarget,
    }
  }

  return null
}

export function isRecentRenewalsActionUndoRequest(message = '') {
  const normalized = normalizeActionDecisionMessage(message)

  return Boolean(
    normalized && UNDO_COMPLETED_ACTION_PATTERNS.some(pattern => pattern.test(normalized))
  )
}

function resolveRecentActionScope(request = {}, scope = {}, actorToken = '') {
  if (request?.selectorSource !== 'context' || scope?.serviceId) {
    return scope
  }

  const recentContext = getRecentActionContext(actorToken)

  if (!recentContext?.target?.id) {
    return scope
  }

  return {
    ...scope,
    serviceId: recentContext.target.id,
  }
}

function applyScope(services = [], {customerId = null, groupId = null, serviceId = null} = {}) {
  return services.filter(service => {
    if (serviceId && String(service?.id) !== String(serviceId)) return false
    if (customerId && String(service?.customer?.id) !== String(customerId)) return false
    if (groupId && String(service?.customer?.group?.id) !== String(groupId)) return false

    return true
  })
}

function getCustomerSubscriptions(service = {}) {
  return (service?.subscriptions || []).filter(subscription => subscription?.isSupplier !== true)
}

function getSupplierSubscriptions(service = {}) {
  return (service?.subscriptions || []).filter(subscription => subscription?.isSupplier === true)
}

function getPrimarySubscription(subscriptions = []) {
  return (
    [...subscriptions]
      .filter(subscription => subscription?.plan || subscription?.endsOn)
      .sort((a, b) => {
        const da = a?.endsOn ? new Date(a.endsOn).getTime() : Number.MAX_SAFE_INTEGER

        const db = b?.endsOn ? new Date(b.endsOn).getTime() : Number.MAX_SAFE_INTEGER

        return da - db
      })[0] || null
  )
}

function getSupplierNames(service = {}) {
  const supplierSubscriptions = getSupplierSubscriptions(service)

  const source = supplierSubscriptions.length ? supplierSubscriptions : service?.subscriptions || []

  return [
    ...new Set(source.map(subscription => subscription?.plan?.supplier?.name).filter(Boolean)),
  ]
}

function getPlanNames(service = {}) {
  return [
    ...new Set(
      (service?.subscriptions || []).map(subscription => subscription?.plan?.name).filter(Boolean)
    ),
  ]
}

function formatDate(value) {
  if (!value) return null

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return null

  return new Intl.DateTimeFormat('it-IT').format(date)
}

function buildCandidateDetails(service = {}) {
  const customerSubscription = getPrimarySubscription(getCustomerSubscriptions(service))

  const supplierSubscription = getPrimarySubscription(getSupplierSubscriptions(service))

  return {
    id: service?.id || null,
    serviceName: getServiceLabel(service),
    customerName: service?.customer?.name || null,
    groupName: service?.customer?.group?.name || null,
    customerPlan: customerSubscription?.plan?.name || null,
    supplierPlan: supplierSubscription?.plan?.name || null,
    suppliers: getSupplierNames(service),
    customerExpiry: formatDate(customerSubscription?.endsOn),
    supplierExpiry: formatDate(supplierSubscription?.endsOn),
    toRenew: getServiceFlagValue(service, 'toRenew'),
    dontRenew: getServiceFlagValue(service, 'dontRenew'),
    autoRenew: getServiceFlagValue(service, 'autoRenew'),
  }
}

function toReferenceItem(service = {}) {
  return {
    id: service?.id || null,
    ids: service?.id ? [service.id] : [],
    servizio: service?.name || null,
    dominio: service?.domains_id?.name || service?.domain?.name || null,
    cliente: service?.customer?.name || null,
    customerId: service?.customer?.id || null,
    gruppo: service?.customer?.group?.name || null,
    groupId: service?.customer?.group?.id || null,
  }
}

function uniqueServiceIds(item = {}) {
  return [...new Set([...(item?.ids || []), item?.id].filter(Boolean).map(String))]
}

function buildCurrentPreviousListItems({previousState, services, settings, scope}) {
  if (Array.isArray(previousState?.data?.items)) {
    return previousState.data.items
  }

  if (!previousState?.query?.filters?.length) {
    return []
  }

  return buildServiceListPayload({
    services,
    settings,
    message: previousState.sourceMessage || previousState.query.sourceMessage || '',
    previousQuery: previousState.query,
    pagination: {
      direction: 'current',
      limit: previousState.limit || previousState.query.limit || 20,
      offset: previousState.offset || previousState.query.offset || 0,
    },
    includeDontRenewOverride:
      typeof previousState.query.includeDontRenew === 'boolean'
        ? previousState.query.includeDontRenew
        : null,
    customerId: scope.customerId,
    groupId: scope.groupId,
    serviceId: scope.serviceId,
  }).items
}

function resolveFromPreviousList({request, services, settings, history, scope, message}) {
  const previousState = pickPreviousServiceListState(history, scope, settings, message)

  if (!previousState) {
    return {
      status: 'missing-list',
    }
  }

  const items = buildCurrentPreviousListItems({
    previousState,
    services,
    settings,
    scope,
  })

  return resolveServiceListReference({
    request: {
      selector: request.selector,
    },
    items,
  })
}

function resolveNamedTarget({request, services, scope}) {
  const scoped = applyScope(services, scope)
  const namedTarget = String(request.namedTarget || '').trim()

  const directIdMatch = scoped.find(service => String(service?.id) === namedTarget)

  if (directIdMatch) {
    return {
      status: 'resolved',
      item: toReferenceItem(directIdMatch),
    }
  }

  return resolveServiceListReference({
    request: {
      selector: {
        kind: 'text',
        term: namedTarget,
      },
    },
    items: scoped.map(toReferenceItem),
  })
}

function resolveContextTarget({services, scope}) {
  if (!scope.serviceId) {
    return {
      status: 'missing-target',
    }
  }

  const service = applyScope(services, scope)[0]

  return service
    ? {
        status: 'resolved',
        item: toReferenceItem(service),
      }
    : {
        status: 'not-found',
        term: scope.serviceId,
      }
}

function buildResolutionClarification(resolution = {}, services = [], request = {}) {
  if (resolution.status === 'missing-list') {
    return 'Non ho una lista precedente da cui selezionare il servizio. Chiedimi prima quali servizi vuoi vedere.'
  }

  if (resolution.status === 'missing-target') {
    return 'Indica quale servizio vuoi modificare, usando il nome oppure un riferimento alla lista precedente.'
  }

  if (resolution.status === 'empty-list') {
    return 'La lista precedente non contiene servizi selezionabili.'
  }

  if (resolution.status === 'out-of-range') {
    return `La pagina corrente contiene ${
      resolution.available || 0
    } servizi. Indica una posizione compresa tra 1 e ${resolution.available || 0}.`
  }

  if (resolution.status === 'not-found') {
    return `Non ho trovato un servizio corrispondente a "${
      resolution.term || ''
    }". Indica un nome più preciso.`
  }

  if (resolution.status === 'ambiguous') {
    const config = getServiceFlagActionConfig(request.field)
    const label = config?.label || request.label || 'FLAG'

    const question =
      request.desiredValue === true
        ? `Quale vuoi segnare come ${label}?`
        : `Da quale vuoi rimuovere ${label}?`

    const rows = (resolution.candidates || []).slice(0, 8).map((candidate, index) => {
      const ids = uniqueServiceIds(candidate.item || {})

      const service = services.find(item => ids.includes(String(item?.id)))

      const details = buildCandidateDetails(service || {})
      const currentValue = details[request.field] === true

      return [
        `${index + 1}. ${details.serviceName || 'Servizio'} (ID ${details.id || '—'})`,
        `   Cliente: ${details.customerName || '—'}`,
        `   Gruppo: ${details.groupName || '—'}`,
        `   Piano cliente: ${details.customerPlan || '—'}`,
        `   Fornitore: ${details.suppliers.join(', ') || '—'}`,
        `   Scadenza cliente: ${details.customerExpiry || '—'}`,
        `   Scadenza fornitore: ${details.supplierExpiry || '—'}`,
        `   Stato attuale: ${label} ${currentValue ? 'attivo' : 'non attivo'}`,
      ].join('\n')
    })

    return [
      `Ho trovato più servizi corrispondenti a "${resolution.term || ''}".`,
      question,
      '',
      ...rows,
      '',
      'Rispondi con il numero, con l’ID oppure con un dettaglio distintivo, ad esempio “quello con fornitore Webcloud” o “quello con piano DomProf170”.',
    ].join('\n')
  }

  return 'Non sono riuscito a identificare un solo servizio. Indica il nome esatto o il numero della riga.'
}

function findResolvedService(services = [], item = {}) {
  const ids = uniqueServiceIds(item)

  if (ids.length !== 1) {
    return {
      status: ids.length > 1 ? 'grouped-row' : 'not-found',
      ids,
    }
  }

  const service = services.find(candidate => String(candidate?.id) === ids[0])

  return service
    ? {
        status: 'resolved',
        service,
      }
    : {
        status: 'not-found',
        ids,
      }
}

function getServiceLabel(service = {}) {
  return service?.name || service?.domains_id?.name || service?.domain?.name || String(service?.id)
}

function getServiceFlagValue(service = {}, field) {
  if (field === 'toRenew') {
    return service?.toRenew === true || service?.to_renew === true
  }

  if (field === 'dontRenew') {
    return service?.dontRenew === true || service?.dont_renew === true
  }

  if (field === 'autoRenew') {
    return service?.autoRenew === true || service?.auto_renew === true
  }

  return false
}

function buildChange(field, label, from, to) {
  return {
    field,
    label,
    from,
    to,
  }
}

const SERVICE_FLAG_LABELS = {
  dontRenew: 'NON RINNOVARE',
  autoRenew: 'RINNOVO AUTOMATICO',
  toRenew: 'DA RINNOVARE',
}

function buildServiceFlagMutationPlan(service, requestedField, requestedValue) {
  const currentFlags = {
    dontRenew: getServiceFlagValue(service, 'dontRenew'),
    autoRenew: getServiceFlagValue(service, 'autoRenew'),
    toRenew: getServiceFlagValue(service, 'toRenew'),
  }

  const nextFlags = {
    ...currentFlags,
    [requestedField]: requestedValue,
  }

  if (requestedField === 'dontRenew' && requestedValue === true) {
    nextFlags.autoRenew = false
    nextFlags.toRenew = false
  }

  if (requestedValue === true && ['autoRenew', 'toRenew'].includes(requestedField)) {
    nextFlags.dontRenew = false
  }

  const orderedFields = [
    requestedField,
    ...Object.keys(SERVICE_FLAG_LABELS).filter(field => field !== requestedField),
  ]

  const changes = orderedFields
    .filter(field => currentFlags[field] !== nextFlags[field])
    .map(field =>
      buildChange(field, SERVICE_FLAG_LABELS[field], currentFlags[field], nextFlags[field])
    )

  return {
    currentFlags,
    nextFlags,
    changes,
    expectedFlags: Object.fromEntries(changes.map(change => [change.field, change.from])),
    desiredFlags: Object.fromEntries(changes.map(change => [change.field, change.to])),
  }
}

function joinItalian(items = []) {
  if (!items.length) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} e ${items[1]}`

  return `${items.slice(0, -1).join(', ')} e ${items.at(-1)}`
}

function describePlannedFlagChanges(changes = []) {
  return joinItalian(
    changes.map(change => (change.to ? `attiverò ${change.label}` : `disattiverò ${change.label}`))
  )
}

function describeCompletedFlagChanges(changes = []) {
  return joinItalian(
    changes.map(change => (change.to ? `${change.label} attivato` : `${change.label} disattivato`))
  )
}

function isCoherentServiceFlagState(flags = {}) {
  return !(flags.dontRenew === true && (flags.autoRenew === true || flags.toRenew === true))
}

function buildUndoUnavailableResponse(reason, reply) {
  return {
    ok: true,
    intent: 'clarification',
    source: 'tool-fast',
    reply,

    data: {
      type: 'clarification',
      reason,
    },

    meta: buildActionMeta('clarification', {
      guard: reason,
    }),
  }
}

export function buildRecentRenewalsActionUndoPreview({services = [], actorToken = ''} = {}) {
  cleanupProposals()
  cleanupRecentActionContexts()

  const recentContext = getRecentActionContext(actorToken)

  const completed = recentContext?.lastCompleted || null

  if (!completed) {
    return buildUndoUnavailableResponse(
      'action-undo-missing',
      'Non ho un’operazione recente da annullare.'
    )
  }

  if (completed.undoneAt) {
    return buildUndoUnavailableResponse(
      'action-already-undone',
      'L’ultima operazione è già stata annullata.'
    )
  }

  const service = services.find(item => String(item?.id) === String(completed.target?.id))

  if (!service) {
    return buildUndoUnavailableResponse(
      'action-undo-target-not-found',
      'Il servizio dell’ultima operazione non è più disponibile.'
    )
  }

  if (!isCoherentServiceFlagState(completed.beforeFlags)) {
    return buildUndoUnavailableResponse(
      'action-undo-invalid-previous-state',
      'Non posso ripristinare lo stato precedente perché non rispetta più le regole di coerenza tra i flag.'
    )
  }

  const currentFlags = {
    dontRenew: getServiceFlagValue(service, 'dontRenew'),

    autoRenew: getServiceFlagValue(service, 'autoRenew'),

    toRenew: getServiceFlagValue(service, 'toRenew'),
  }

  const fields = Object.keys(completed.afterFlags || {})

  const staleFields = fields.filter(field => currentFlags[field] !== completed.afterFlags[field])

  if (staleFields.length) {
    return buildUndoUnavailableResponse(
      'action-undo-state-changed',
      'Lo stato del servizio è cambiato dopo l’ultima operazione. Per sicurezza non posso annullarla automaticamente.'
    )
  }

  const changes = fields
    .filter(field => completed.afterFlags[field] !== completed.beforeFlags[field])
    .map(field =>
      buildChange(
        field,
        SERVICE_FLAG_LABELS[field] || field,
        completed.afterFlags[field],
        completed.beforeFlags[field]
      )
    )

  if (!changes.length) {
    return buildUndoUnavailableResponse(
      'action-undo-noop',
      'L’ultima operazione non contiene modifiche da ripristinare.'
    )
  }

  const now = Date.now()
  const actionId = randomUUID()

  const actorFingerprint = fingerprintToken(actorToken)

  supersedePendingProposals(actorFingerprint)

  const proposal = {
    actionId,
    tool: TOOL_ID,

    kind: 'undo',
    undoOfActionId: completed.actionId,

    status: 'pending',
    actorFingerprint,

    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,

    target: completed.target,
    changes,

    field: null,
    label: 'RIPRISTINO STATO PRECEDENTE',
    requestedValue: null,

    expectedFlags: Object.fromEntries(changes.map(change => [change.field, change.from])),

    desiredFlags: Object.fromEntries(changes.map(change => [change.field, change.to])),
  }

  proposals.set(actionId, proposal)

  rememberRecentActionTarget(actorToken, proposal.target)

  auditAction('undo-proposed', proposal, {
    undoOfActionId: completed.actionId,
  })

  return {
    ok: true,
    intent: 'action-proposal',
    source: 'tool-fast',

    reply:
      `Ripristinerò lo stato precedente del servizio "${proposal.target.label}": ` +
      `${describePlannedFlagChanges(changes)}. Confermi?`,

    data: {
      type: 'action-preview',

      action: {
        actionId,
        tool: TOOL_ID,
        kind: 'undo',
        undoOfActionId: completed.actionId,

        requiresConfirmation: true,

        expiresAt: new Date(proposal.expiresAt).toISOString(),

        target: proposal.target,
        changes,
      },
    },

    meta: buildActionMeta('action-proposal', {
      actionId,
      actionStatus: 'pending',
      actionKind: 'undo',
      undoOfActionId: completed.actionId,
    }),
  }
}

function buildActionMeta(intent, extra = {}) {
  return {
    moduleId: 'facile.renewals',
    source: 'tool-fast',
    intent,
    tool: TOOL_ID,
    ...extra,
  }
}

function rememberPendingClarification({request, resolution, services, scope, actorToken}) {
  const actorFingerprint = fingerprintToken(actorToken)

  const candidateIds = (resolution?.candidates || [])
    .flatMap(candidate => uniqueServiceIds(candidate?.item || {}))
    .filter(id => services.some(service => String(service?.id) === String(id)))

  if (!candidateIds.length) return

  pendingClarifications.set(actorFingerprint, {
    request,
    scope: resolvedScope,
    candidateIds: [...new Set(candidateIds.map(String))],
    createdAt: Date.now(),
    expiresAt: Date.now() + PROPOSAL_TTL_MS,
  })
}

function normalizeComparable(value = '') {
  return normalizeSearchText(value)
    .replace(/[^a-z0-9à-ÿ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractOrdinalIndex(message = '') {
  const text = normalizeComparable(message)

  const numeric = text.match(/^\s*(\d+)\s*$/)

  if (numeric) {
    return Number(numeric[1]) - 1
  }

  const ordinals = [
    ['primo', 'prima'],
    ['secondo', 'seconda'],
    ['terzo', 'terza'],
    ['quarto', 'quarta'],
    ['quinto', 'quinta'],
    ['sesto', 'sesta'],
    ['settimo', 'settima'],
    ['ottavo', 'ottava'],
  ]

  return ordinals.findIndex(words =>
    words.some(word => new RegExp(`\\b${word}\\b`, 'i').test(text))
  )
}

function buildSelectionSearchText(service = {}) {
  const details = buildCandidateDetails(service)

  return normalizeComparable(
    [
      details.id,
      details.serviceName,
      details.customerName,
      details.groupName,
      details.customerPlan,
      details.supplierPlan,
      ...details.suppliers,
      ...getPlanNames(service),
      details.customerExpiry,
      details.supplierExpiry,
    ]
      .filter(Boolean)
      .join(' ')
  )
}

function resolvePendingCandidate(message, services = [], candidateIds = []) {
  const candidates = candidateIds
    .map(id => services.find(service => String(service?.id) === String(id)))
    .filter(Boolean)

  if (!candidates.length) {
    return {
      status: 'not-found',
    }
  }

  const raw = String(message || '').trim()
  const normalized = normalizeComparable(raw)
  const ordinalIndex = extractOrdinalIndex(raw)

  if (ordinalIndex >= 0 && ordinalIndex < candidates.length) {
    return {
      status: 'resolved',
      service: candidates[ordinalIndex],
    }
  }

  const exactId = candidates.find(service => String(service?.id) === raw)

  if (exactId) {
    return {
      status: 'resolved',
      service: exactId,
    }
  }

  const removable = normalized
    .replace(
      /\b(quello|quella|servizio|dominio|con|il|lo|la|l|fornitore|piano|cliente|gruppo|che|ha|scade|scadenza)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()

  if (!removable) {
    return {
      status: 'unrecognized',
    }
  }

  const matched = candidates.filter(service =>
    buildSelectionSearchText(service).includes(removable)
  )

  if (matched.length === 1) {
    return {
      status: 'resolved',
      service: matched[0],
    }
  }

  if (matched.length > 1) {
    return {
      status: 'ambiguous',
      candidates: matched,
    }
  }

  return {
    status: 'not-found',
  }
}

export function hasPendingRenewalsActionClarification({actorToken = ''} = {}) {
  cleanupPendingClarifications()

  return pendingClarifications.has(fingerprintToken(actorToken))
}

export function handlePendingRenewalsActionClarification({
  message = '',
  services = [],
  settings = {},
  history = [],
  scope = {},
  actorToken = '',
} = {}) {
  cleanupPendingClarifications()

  const actorFingerprint = fingerprintToken(actorToken)
  const pending = pendingClarifications.get(actorFingerprint)

  if (!pending) return null

  const selection = resolvePendingCandidate(message, services, pending.candidateIds)

  if (selection.status === 'unrecognized') {
    return null
  }

  if (selection.status !== 'resolved') {
    const candidateServices = pending.candidateIds
      .map(id => services.find(service => String(service?.id) === String(id)))
      .filter(Boolean)

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply:
        selection.status === 'ambiguous'
          ? 'Il dettaglio indicato corrisponde ancora a più servizi. Specifica anche il piano, il fornitore, la scadenza oppure usa il numero/ID.'
          : [
              'Non riesco a collegare la risposta a uno dei servizi proposti.',
              'Puoi indicare il numero, l’ID o un dettaglio come fornitore, piano o scadenza.',
              '',
              ...candidateServices.map((service, index) => {
                const details = buildCandidateDetails(service)

                return `${index + 1}. ${details.serviceName} (ID ${details.id}) — ${
                  details.customerPlan || 'piano —'
                } — ${details.suppliers.join(', ') || 'fornitore —'} — ${
                  details.customerExpiry || 'scadenza —'
                }`
              }),
            ].join('\n'),
      data: {
        type: 'clarification',
        reason: `action-target-${selection.status}`,
      },
      meta: buildActionMeta('clarification', {
        guard: `action-target-${selection.status}`,
      }),
    }
  }

  pendingClarifications.delete(actorFingerprint)

  return buildServiceFlagActionPreview({
    request: {
      ...pending.request,
      selector: null,
      selectorSource: 'context',
      namedTarget: null,
    },
    services,
    settings,
    history,
    scope: {
      ...pending.scope,
      ...scope,
      serviceId: selection.service.id,
    },
    actorToken,
  })
}

export function buildServiceFlagActionPreview({
  request,
  services = [],
  settings = {},
  history = [],
  scope = {},
  actorToken = '',
} = {}) {
  cleanupProposals()
  cleanupPendingClarifications()
  cleanupRecentActionContexts()

  const resolvedScope = resolveRecentActionScope(request, scope, actorToken)

  const resolution =
    request.selectorSource === 'previous-list'
      ? resolveFromPreviousList({
          request,
          services,
          settings,
          history,
          scope: resolvedScope,
          message: request.message || '',
        })
      : request.selectorSource === 'named-target'
        ? resolveNamedTarget({
            request,
            services,
            scope: resolvedScope,
          })
        : resolveContextTarget({
            services,
            scope: resolvedScope,
          })

  if (resolution.status !== 'resolved') {
    if (resolution.status === 'ambiguous') {
      rememberPendingClarification({
        request,
        resolution,
        services,
        scope,
        actorToken,
      })
    }

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildResolutionClarification(resolution, services, request),
      data: {
        type: 'clarification',
        reason: `action-target-${resolution.status || 'unresolved'}`,
      },
      meta: buildActionMeta('clarification', {
        guard: `action-target-${resolution.status || 'unresolved'}`,
      }),
    }
  }

  const resolvedService = findResolvedService(services, resolution.item)

  if (resolvedService.status === 'grouped-row') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply:
        'La riga selezionata raggruppa più servizi. Apri il dettaglio o indica il nome esatto del singolo servizio da modificare.',
      data: {
        type: 'clarification',
        reason: 'action-target-grouped-row',
        serviceIds: resolvedService.ids,
      },
      meta: buildActionMeta('clarification', {
        guard: 'action-target-grouped-row',
      }),
    }
  }

  if (resolvedService.status !== 'resolved') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: 'Il servizio selezionato non è più disponibile. Ripeti la ricerca prima di procedere.',
      data: {
        type: 'clarification',
        reason: 'action-target-not-found',
      },
      meta: buildActionMeta('clarification', {
        guard: 'action-target-not-found',
      }),
    }
  }

  const config = getServiceFlagActionConfig(request.field)

  if (!config) {
    return {
      ok: false,
      intent: 'action-error',
      source: 'tool-fast',
      reply: 'Il flag richiesto non è supportato.',
      data: {
        type: 'action-error',
        error: {
          code: 'unsupported-service-flag',
          details: {
            field: request.field || null,
          },
        },
      },
      meta: buildActionMeta('action-error', {
        errorCode: 'unsupported-service-flag',
      }),
    }
  }

  const service = resolvedService.service
  const desired = request.desiredValue === true

  rememberRecentActionTarget(actorToken, target)

  const mutationPlan = buildServiceFlagMutationPlan(service, config.field, desired)

  if (!mutationPlan.changes.length) {
    return {
      ok: true,
      intent: 'action-result',
      source: 'tool-fast',
      reply: desired
        ? `Il servizio "${target.label}" ha già ${config.label} attivo e gli stati collegati sono già coerenti.`
        : `Il servizio "${target.label}" non ha ${config.label} attivo.`,
      data: {
        type: 'action-result',
        action: {
          tool: TOOL_ID,
          requiresConfirmation: false,
          target,
          changes: [],
        },
        result: {
          status: 'noop',
          changed: false,
        },
      },
      meta: buildActionMeta('action-result', {
        actionStatus: 'noop',
      }),
    }
  }

  const now = Date.now()
  const actionId = randomUUID()
  const actorFingerprint = fingerprintToken(actorToken)

  supersedePendingProposals(actorFingerprint)

  const proposal = {
    actionId,
    tool: TOOL_ID,
    status: 'pending',
    actorFingerprint,
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
    target,
    changes: mutationPlan.changes,
    field: config.field,
    label: config.label,
    requestedValue: desired,
    expectedFlags: mutationPlan.expectedFlags,
    desiredFlags: mutationPlan.desiredFlags,
  }

  proposals.set(actionId, proposal)
  auditAction('proposed', proposal)

  return {
    ok: true,
    intent: 'action-proposal',
    source: 'tool-fast',
    reply:
      `Sul servizio "${target.label}" ` +
      `${describePlannedFlagChanges(mutationPlan.changes)}. Confermi?`,
    data: {
      type: 'action-preview',
      action: {
        actionId,
        tool: TOOL_ID,
        requiresConfirmation: true,
        expiresAt: new Date(proposal.expiresAt).toISOString(),
        target,
        changes: mutationPlan.changes,
      },
    },
    meta: buildActionMeta('action-proposal', {
      actionId,
      actionStatus: 'pending',
    }),
  }
}

function actionError(proposal, code, reply, details = null) {
  return {
    ok: false,
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
            changes: proposal.changes,
          }
        : null,
      error: {
        code,
        details,
      },
    },
    meta: buildActionMeta('action-error', {
      actionId: proposal?.actionId || null,
      actionStatus: proposal?.status || 'not-found',
      errorCode: code,
    }),
  }
}

export async function handlePendingRenewalsActionDecisionMessage({
  message = '',
  actorToken = '',
} = {}) {
  const decision = parseActionDecisionMessage(message)

  if (!decision) return null

  const proposal = getPendingProposalForActor(actorToken)

  if (!proposal) return null

  return handleRenewalsActionDecision({
    action: {
      actionId: proposal.actionId,
      decision,
    },
    actorToken,
  })
}

export async function handleRenewalsActionDecision({action = null, actorToken = ''} = {}) {
  cleanupProposals()

  const actionId = String(action?.actionId || '').trim()
  const decision = String(action?.decision || '')
    .trim()
    .toLowerCase()

  if (!actionId) {
    return actionError(
      null,
      'missing-action-id',
      'actionId obbligatorio per confermare o annullare.'
    )
  }

  if (!['confirm', 'cancel'].includes(decision)) {
    return actionError(
      null,
      'invalid-decision',
      'La decisione deve essere "confirm" oppure "cancel".'
    )
  }

  const proposal = proposals.get(actionId)

  if (!proposal) {
    return actionError(
      null,
      'action-not-found',
      'La proposta non esiste o non è più disponibile. Ripeti la richiesta.'
    )
  }

  if (proposal.actorFingerprint !== fingerprintToken(actorToken)) {
    auditAction('rejected-actor', proposal)
    return actionError(
      proposal,
      'action-owner-mismatch',
      'Questa proposta appartiene a un’altra sessione e non può essere eseguita.'
    )
  }

  if (proposal.expiresAt <= Date.now()) {
    proposal.status = 'expired'
    proposal.finishedAt = Date.now()
    auditAction('expired', proposal)
    return actionError(
      proposal,
      'action-expired',
      'La proposta è scaduta. Ripeti la richiesta per generare una nuova anteprima.'
    )
  }

  if (proposal.status !== 'pending') {
    return actionError(
      proposal,
      'action-already-finalized',
      'Questa proposta è già stata confermata, annullata o conclusa.'
    )
  }

  if (decision === 'cancel') {
    proposal.status = 'cancelled'
    proposal.finishedAt = Date.now()
    auditAction('cancelled', proposal)

    return {
      ok: true,
      intent: 'action-confirmation',
      source: 'tool-fast',
      reply: 'Operazione annullata. Nessuna modifica è stata eseguita.',
      data: {
        type: 'action-confirmation',
        action: {
          actionId: proposal.actionId,
          tool: proposal.tool,
          target: proposal.target,
          changes: proposal.changes,
        },
        decision: 'cancel',
        status: 'cancelled',
      },
      meta: buildActionMeta('action-confirmation', {
        actionId: proposal.actionId,
        actionStatus: 'cancelled',
      }),
    }
  }

  proposal.status = 'executing'
  auditAction('confirmed', proposal)

  try {
    const result = await updateServiceFlags({
      serviceId: proposal.target.id,
      expected: proposal.expectedFlags,
      changes: proposal.desiredFlags,
      actionId: proposal.actionId,
    })

    proposal.status = 'completed'
    proposal.finishedAt = Date.now()

    if (proposal.kind === 'undo') {
      markCompletedActionAsUndone(actorToken, proposal)
    } else {
      rememberCompletedAction(actorToken, proposal)
    }

    auditAction('completed', proposal, {
      result: {
        changed: result?.changed === true,
      },
    })

    return {
      ok: true,
      intent: 'action-result',
      source: 'tool-fast',
      reply:
        proposal.kind === 'undo'
          ? `Stato precedente ripristinato sul servizio "${proposal.target.label}": ${describeCompletedFlagChanges(
              proposal.changes
            )}.`
          : `Operazione completata sul servizio "${proposal.target.label}": ${describeCompletedFlagChanges(
              proposal.changes
            )}.`,
      data: {
        type: 'action-result',
        action: {
          actionId: proposal.actionId,
          tool: proposal.tool,
          target: proposal.target,
          changes: proposal.changes,
        },
        result: {
          status: 'completed',
          changed: result?.changed === true,
          service: result?.service || null,
        },
      },
      meta: buildActionMeta('action-result', {
        actionId: proposal.actionId,
        actionStatus: 'completed',
      }),
    }
  } catch (error) {
    proposal.status = 'failed'
    proposal.finishedAt = Date.now()

    const staleState = /\(409\)/.test(String(error?.message || ''))
    const code = staleState ? 'service-state-changed' : 'execution-failed'
    const reply = staleState
      ? 'Lo stato del servizio è cambiato dopo l’anteprima. Nessuna modifica è stata eseguita: ripeti la richiesta.'
      : 'Non è stato possibile completare l’operazione. Nessuna ulteriore esecuzione verrà tentata con questa proposta.'

    auditAction('failed', proposal, {
      error: error?.message || String(error),
      code,
    })

    return actionError(proposal, code, reply)
  }
}
