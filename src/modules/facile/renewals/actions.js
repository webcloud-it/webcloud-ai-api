import {createHash, randomUUID} from 'node:crypto'

import {normalizeSearchText} from '../../../utils/text.js'
import {buildServiceListPayload} from './serviceQueries.js'
import {parseServiceListSelector, resolveServiceListReference} from './serviceListReferences.js'
import {pickPreviousServiceListState} from './serviceListState.js'
import {
  copySupplierExpiryToCustomer,
  updateServiceFlags,
  updateSubscriptionEndDate,
} from './service.js'

const TOOL_ID = 'renewals.update-service-flags'
const TRANSFER_TOOL_ID = 'renewals.set-transfer-target'
const INVOICE_DATE_TOOL_ID = 'renewals.set-invoice-date'
const PLESK_PLAN_SYNC_TOOL_ID = 'renewals.set-plesk-plan-sync'
const AUTH_CODE_TOOL_ID = 'renewals.set-auth-code'
const SUBSCRIPTION_END_DATE_TOOL_ID = 'renewals.set-subscription-end-date'
const COPY_SUPPLIER_EXPIRY_TOOL_ID = 'renewals.copy-supplier-expiry-to-customer'
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

const TRANSFER_TARGET_TERM_PATTERN =
  /\bda\s+trasferire\b|\bper\s+(?:il\s+)?trasferimento\b|\bfornitore\s+di\s+trasferimento\b|\bdestinazione\s+del\s+trasferimento\b|\bto[_ -]?transfer\b/i

const TRANSFER_PROVIDER_SEPARATOR_PATTERN = '(?:a|ad|verso|su|con|presso)'

const INVOICE_DATE_TERM_PATTERN =
  /\bdata\s+(?:di\s+)?fatturazione\b|\bfatturazione\b|\binvoice[_ -]?date\b/i

const SUBSCRIPTION_END_DATE_TERM_PATTERN =
  /\b(?:data\s+(?:di\s+)?)?scadenza\b|\bends?[_ -]?on\b/i

const SUPPLIER_SUBSCRIPTION_TERM_PATTERN =
  /\b(?:fornitore|fornitori|supplier|provider)\b/i

const SUBSCRIPTION_DATE_SET_VERBS_PATTERN =
  `(?:${SET_ACTION_VERBS_PATTERN}|modifica|modificalo|modificala|cambia|cambialo|cambiala|aggiorna|aggiornalo|aggiornala|proroga|prorogalo|prorogala|posticipa|posticipalo|posticipala|anticipa|anticipalo|anticipala)`

const COPY_SUPPLIER_EXPIRY_VERBS_PATTERN =
  '(?:copia|copialo|copiala|copiami|allinea|allinealo|allineala|sincronizza|sincronizzalo|sincronizzala|usa|usalo|usala|utilizza|utilizzalo|utilizzala|imposta|impostalo|impostala|porta|portalo|portala|riporta|riportalo|riportala)'

const PLESK_PLAN_SYNC_TERM_PATTERN =
  /\bno\s*sync\s+(?:del\s+)?piano\b|\b(?:sincronizzazione|sincronizza(?:re|zione)?|sync)\b[\s\S]{0,50}\b(?:piano|plan)\b[\s\S]{0,30}\bplesk\b|\bplesk\b[\s\S]{0,50}\b(?:sincronizzazione|sincronizza(?:re|zione)?|sync)\b(?:[\s\S]{0,30}\b(?:piano|plan)\b)?/i

const AUTH_CODE_TERM_PATTERN =
  /\b(?:auth\s*code|authcode|codice\s+(?:di\s+)?autorizzazione|codice\s+(?:di\s+)?trasferimento|codice\s+auth|epp\s*code|codice\s+epp|authorization\s+code)\b/i

const AUTH_CODE_SET_VERBS_PATTERN =
  `(?:${SET_ACTION_VERBS_PATTERN}|salva|salvalo|salvala|inserisci|inseriscilo|inseriscila|registra|registralo|registrala|aggiorna|aggiornalo|aggiornala|modifica|modificalo|modificala|cambia|cambialo|cambiala|sostituisci|sostituiscilo|sostituiscila)`

const AUTH_CODE_MAX_LENGTH = 512

const ITALIAN_MONTHS = Object.freeze({
  gennaio: 0,
  febbraio: 1,
  marzo: 2,
  aprile: 3,
  maggio: 4,
  giugno: 5,
  luglio: 6,
  agosto: 7,
  settembre: 8,
  ottobre: 9,
  novembre: 10,
  dicembre: 11,
})

function toLocalNoonIso(year, monthIndex, day) {
  const date = new Date(year, monthIndex, day, 12, 0, 0, 0)

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== day
  ) {
    return null
  }

  const pad = value => String(value).padStart(2, '0')

  return `${year}-${pad(monthIndex + 1)}-${pad(day)}T12:00:00`
}

function normalizeInvoiceDateValue(value) {
  if (!value) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  return toLocalNoonIso(date.getFullYear(), date.getMonth(), date.getDate())
}

function parseInvoiceDateValue(message = '') {
  const text = normalizeSearchText(message)

  let match = text.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/)
  if (match) {
    return toLocalNoonIso(Number(match[3]), Number(match[2]) - 1, Number(match[1]))
  }

  match = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/)
  if (match) {
    return toLocalNoonIso(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  }

  match = text.match(
    /\b(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+(\d{4}))?\b/i
  )

  if (match) {
    const year = match[3] ? Number(match[3]) : new Date().getFullYear()
    return toLocalNoonIso(year, ITALIAN_MONTHS[match[2].toLowerCase()], Number(match[1]))
  }

  return null
}

function formatInvoiceDate(value) {
  const normalized = normalizeInvoiceDateValue(value)
  if (!normalized) return 'non impostata'

  return new Intl.DateTimeFormat('it-IT').format(new Date(normalized))
}


function normalizeAuthCodeValue(value) {
  if (value === null || value === undefined) return null

  const normalized = String(value).trim()

  return normalized || null
}

function authCodeState(value) {
  return {
    isSet: Boolean(normalizeAuthCodeValue(value)),
    sensitive: true,
  }
}

function stripMatchingQuotes(value = '') {
  const text = String(value || '').trim()
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['«', '»'],
  ]

  for (const [start, end] of pairs) {
    if (text.startsWith(start) && text.endsWith(end) && text.length >= 2) {
      return text.slice(start.length, -end.length).trim()
    }
  }

  return text
}

function cleanAuthCodeInput(value = '') {
  return normalizeAuthCodeValue(stripMatchingQuotes(value))
}

function redactAuthCodeMessage(message = '', authCode = null) {
  const code = normalizeAuthCodeValue(authCode)
  if (!code) return String(message || '').trim()

  return String(message || '').replace(code, '[RISERVATO]').trim()
}

function cleanAuthCodeServiceTarget(value = '') {
  const cleaned = String(value || '')
    .replace(new RegExp(`\\b${AUTH_CODE_SET_VERBS_PATTERN}\\b`, 'gi'), ' ')
    .replace(new RegExp(`\\b${REMOVE_ACTION_VERBS_PATTERN}\\b`, 'gi'), ' ')
    .replace(AUTH_CODE_TERM_PATTERN, ' ')
    .replace(
      /\b(?:ora|adesso|poi|quindi|allora|invece|il|lo|la|l|un|una|di|del|dello|della|da|dal|dalla|per|su|sul|a|al|nel|nello|nella|servizio|dominio)\b/gi,
      ' '
    )
    .replace(/[,:;!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleanTransferServiceTarget(cleaned)
}

function buildAuthCodeChange(from, to) {
  return {
    field: 'authCode',
    label: 'AUTH CODE',
    from: authCodeState(from),
    to: authCodeState(to),
    sensitive: true,
  }
}

function cleanProviderTarget(value = '') {
  return String(value || '')
    .replace(/^[\s:,-]+|[\s?.!,;:,-]+$/g, '')
    .replace(/^(?:il|lo|la|i|gli|le|un|una)\s+/i, '')
    .replace(/^(?:fornitore|provider)\s+/i, '')
    .trim()
}

function cleanTransferServiceTarget(value = '') {
  const cleaned = cleanTarget(value)
    .replace(/^(?:ora|adesso|poi|quindi|allora|invece)\s+/i, '')
    .trim()

  if (
    /^(?:come|lo|la|questo|questa|quello|quella|il servizio|quel servizio|questo servizio)?$/i.test(
      cleaned
    )
  ) {
    return null
  }

  return cleaned || null
}

function buildTransferRequest({
  message,
  providerQuery = null,
  namedTarget = null,
  selector = null,
  clear = false,
}) {
  const resolvedNamedTarget = selector ? null : cleanTransferServiceTarget(namedTarget)

  return {
    type: 'renewals-transfer-target-request',
    tool: TRANSFER_TOOL_ID,
    message: String(message || '').trim(),
    field: 'toTransfer',
    label: 'DA TRASFERIRE',
    clear,
    providerQuery: clear ? null : cleanProviderTarget(providerQuery),
    selector,
    selectorSource: selector
      ? 'previous-list'
      : resolvedNamedTarget
        ? 'named-target'
        : 'context',
    namedTarget: resolvedNamedTarget,
  }
}


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

export function getRecentRenewalsActionTarget({actorToken = ''} = {}) {
  const context = getRecentActionContext(actorToken)

  return context?.target
    ? {
        ...context.target,
      }
    : null
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
  const beforeValues = proposal.expectedValues || proposal.expectedFlags || {}
  const afterValues = proposal.desiredValues || proposal.desiredFlags || {}

  recentActionContexts.set(actorFingerprint, {
    target: {
      type: 'service',
      id: String(proposal.target.id),
      label: proposal.target.label || String(proposal.target.id),
    },

    lastCompleted: {
      actionId: proposal.actionId,
      tool: proposal.tool || TOOL_ID,
      operation: proposal.operation || 'service-flags',
      target: proposal.target,
      subscription: proposal.subscription ? {...proposal.subscription} : null,

      changes: proposal.changes.map(change => ({...change})),

      beforeValues: {
        ...beforeValues,
      },

      afterValues: {
        ...afterValues,
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


export function parseServiceTransferTargetAction(message = '') {
  const text = String(message || '').trim()
  const normalized = normalizeSearchText(text)

  if (!normalized || !TRANSFER_TARGET_TERM_PATTERN.test(normalized)) {
    return null
  }

  const selector = parseServiceListSelector(text)
  const remove = new RegExp(`\\b${REMOVE_ACTION_VERBS_PATTERN}\\b`, 'i').test(normalized)
  const set = new RegExp(`\\b${SET_ACTION_VERBS_PATTERN}\\b`, 'i').test(normalized)

  if (remove && !set) {
    const targetPatterns = [
      new RegExp(
        `\\b${REMOVE_ACTION_VERBS_PATTERN}\\b[\\s\\S]{0,40}(?:da\\s+trasferire|per\\s+(?:il\\s+)?trasferimento|to[_ -]?transfer)\\s+(?:da|dal|dalla|su|per)\\s+(.+)$`,
        'i'
      ),
      new RegExp(
        `\\b${REMOVE_ACTION_VERBS_PATTERN}\\b\\s+(?:il\\s+|lo\\s+|la\\s+)?(?:servizio\\s+|dominio\\s+)?(.+?)\\s+(?:da\\s+)?(?:da\\s+trasferire|per\\s+(?:il\\s+)?trasferimento|to[_ -]?transfer)\\b`,
        'i'
      ),
    ]

    let namedTarget = null

    if (!selector) {
      for (const pattern of targetPatterns) {
        const match = text.match(pattern)

        if (match?.[1]) {
          namedTarget = match[1]
          break
        }
      }
    }

    return buildTransferRequest({
      message: text,
      selector,
      namedTarget,
      clear: true,
    })
  }

  if (!set || remove) {
    return null
  }

  const patterns = [
    new RegExp(
      `\\b${SET_ACTION_VERBS_PATTERN}\\b\\s+(?:il\\s+|lo\\s+|la\\s+)?(?:servizio\\s+|dominio\\s+)?(.+?)\\s+(?:come\\s+)?(?:da\\s+trasferire|per\\s+(?:il\\s+)?trasferimento|to[_ -]?transfer)\\s+${TRANSFER_PROVIDER_SEPARATOR_PATTERN}\\s+(.+)$`,
      'i'
    ),
    new RegExp(
      `\\b${SET_ACTION_VERBS_PATTERN}\\b[\\s\\S]{0,50}(?:da\\s+trasferire|per\\s+(?:il\\s+)?trasferimento|to[_ -]?transfer)\\s+${TRANSFER_PROVIDER_SEPARATOR_PATTERN}\\s+(.+)$`,
      'i'
    ),
    new RegExp(
      `\\b${SET_ACTION_VERBS_PATTERN}\\b\\s+(.+?)\\s+come\\s+(?:fornitore\\s+di\\s+trasferimento|destinazione\\s+del\\s+trasferimento)\\s+(?:per|su|al|sul)\\s+(.+)$`,
      'i'
    ),
  ]

  const first = text.match(patterns[0])

  if (first?.[2]) {
    return buildTransferRequest({
      message: text,
      selector,
      namedTarget: selector ? null : first[1],
      providerQuery: first[2],
    })
  }

  const contextual = text.match(patterns[1])

  if (contextual?.[1]) {
    return buildTransferRequest({
      message: text,
      selector,
      namedTarget: null,
      providerQuery: contextual[1],
    })
  }

  const providerFirst = text.match(patterns[2])

  if (providerFirst?.[1] && providerFirst?.[2]) {
    return buildTransferRequest({
      message: text,
      selector,
      namedTarget: selector ? null : providerFirst[2],
      providerQuery: providerFirst[1],
    })
  }

  return null
}

export function parseServiceInvoiceDateAction(message = '') {
  const text = String(message || '').trim()
  const normalized = normalizeSearchText(text)

  if (!normalized || !INVOICE_DATE_TERM_PATTERN.test(normalized)) return null

  const selector = parseServiceListSelector(text)
  const remove = new RegExp(`\\b${REMOVE_ACTION_VERBS_PATTERN}\\b`, 'i').test(normalized)
  const set = new RegExp(`\\b${SET_ACTION_VERBS_PATTERN}\\b`, 'i').test(normalized)

  if (remove && !set) {
    const withoutCommand = text
      .replace(new RegExp(`\\b${REMOVE_ACTION_VERBS_PATTERN}\\b`, 'i'), ' ')
      .replace(INVOICE_DATE_TERM_PATTERN, ' ')
      .replace(/\b(?:di|da|dal|dalla|del|dello|della|su|per|a|al)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    const resolvedNamedTarget = selector ? null : cleanTransferServiceTarget(withoutCommand)

    return {
      type: 'renewals-invoice-date-request',
      tool: INVOICE_DATE_TOOL_ID,
      message: text,
      field: 'invoiceDate',
      label: 'DATA DI FATTURAZIONE',
      clear: true,
      desiredDate: null,
      selector,
      selectorSource: selector
        ? 'previous-list'
        : resolvedNamedTarget
          ? 'named-target'
          : 'context',
      namedTarget: resolvedNamedTarget,
    }
  }

  if (!set || remove) return null

  const desiredDate = parseInvoiceDateValue(text)
  if (!desiredDate) return null

  const datePatterns = [
    /\b(?:al|a|per|su|del|dello|della)?\s*\d{1,2}[\/-]\d{1,2}[\/-]\d{4}\b/i,
    /\b(?:al|a|per|su|del|dello|della)?\s*\d{4}-\d{1,2}-\d{1,2}\b/i,
    /\b(?:al|a|per|su|del|dello|della)?\s*\d{1,2}\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+\d{4})?\b/i,
  ]

  let namedTarget = text
    .replace(new RegExp(`\\b${SET_ACTION_VERBS_PATTERN}\\b`, 'i'), ' ')
    .replace(INVOICE_DATE_TERM_PATTERN, ' ')

  for (const datePattern of datePatterns) {
    namedTarget = namedTarget.replace(datePattern, ' ')
  }

  namedTarget = namedTarget
    .replace(/\b(?:di|del|dello|della|per|su|al|a)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const resolvedNamedTarget = selector ? null : cleanTransferServiceTarget(namedTarget)

  return {
    type: 'renewals-invoice-date-request',
    tool: INVOICE_DATE_TOOL_ID,
    message: text,
    field: 'invoiceDate',
    label: 'DATA DI FATTURAZIONE',
    clear: false,
    desiredDate,
    selector,
    selectorSource: selector
      ? 'previous-list'
      : resolvedNamedTarget
        ? 'named-target'
        : 'context',
    namedTarget: resolvedNamedTarget,
  }
}


function cleanSubscriptionEndDateServiceTarget(value = '') {
  const datePatterns = [
    /\b(?:al|a|per|su|del|dello|della)?\s*\d{1,2}[\/-]\d{1,2}[\/-]\d{4}\b/i,
    /\b(?:al|a|per|su|del|dello|della)?\s*\d{4}-\d{1,2}-\d{1,2}\b/i,
    /\b(?:al|a|per|su|del|dello|della)?\s*\d{1,2}\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+\d{4})?\b/i,
  ]

  let cleaned = String(value || '')
    .replace(new RegExp(`\\b${SUBSCRIPTION_DATE_SET_VERBS_PATTERN}\\b`, 'gi'), ' ')
    .replace(/\b(?:data\s+(?:di\s+)?)?scadenza\b/gi, ' ')
    .replace(/\b(?:sottoscrizione|subscription)\b/gi, ' ')
    .replace(/\b(?:cliente|client|customer|fornitore|fornitori|supplier|provider)\b/gi, ' ')
    .replace(/\b(?:id|numero|n)\s+[0-9a-f-]{6,}\b/gi, ' ')

  for (const datePattern of datePatterns) {
    cleaned = cleaned.replace(datePattern, ' ')
  }

  cleaned = cleaned
    .replace(
      /\b(?:ora|adesso|poi|quindi|allora|invece|la|il|lo|l|un|una|del|dello|della|di|da|dal|su|sul|per|a|al|con|nel|nello|nella|servizio|dominio)\b/gi,
      ' '
    )
    .replace(/[,:;!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleanTransferServiceTarget(cleaned)
}

export function parseServiceSubscriptionEndDateAction(message = '') {
  const text = String(message || '').trim()
  const normalized = normalizeSearchText(text)

  if (!normalized || !SUBSCRIPTION_END_DATE_TERM_PATTERN.test(normalized)) return null

  const hasSetVerb = new RegExp(`\\b${SUBSCRIPTION_DATE_SET_VERBS_PATTERN}\\b`, 'i').test(
    normalized
  )

  if (!hasSetVerb) return null

  const desiredDate = parseInvoiceDateValue(text)
  if (!desiredDate) return null

  const selector = parseServiceListSelector(text)
  const subscriptionType = SUPPLIER_SUBSCRIPTION_TERM_PATTERN.test(normalized)
    ? 'supplier'
    : 'customer'

  const explicitSubscriptionMatch = text.match(
    /\b(?:sottoscrizione|subscription)\s+(?:(?:id|numero|n\.?)[\s:#-]*)?([0-9a-f]{6,}(?:-[0-9a-f-]+)?)\b/i
  )

  const namedTarget = selector ? null : cleanSubscriptionEndDateServiceTarget(text)

  return {
    type: 'renewals-subscription-end-date-request',
    tool: SUBSCRIPTION_END_DATE_TOOL_ID,
    message: text,
    field: 'subscriptionEndDate',
    label:
      subscriptionType === 'supplier' ? 'SCADENZA FORNITORE' : 'SCADENZA CLIENTE',
    subscriptionType,
    subscriptionId: explicitSubscriptionMatch?.[1] || null,
    desiredDate,
    selector,
    selectorSource: selector ? 'previous-list' : namedTarget ? 'named-target' : 'context',
    namedTarget,
  }
}


function cleanCopySupplierExpiryServiceTarget(value = '') {
  const cleaned = String(value || '')
    .replace(new RegExp(`\\b${COPY_SUPPLIER_EXPIRY_VERBS_PATTERN}\\b`, 'gi'), ' ')
    .replace(/\b(?:data\s+(?:di\s+)?)?scadenza\b/gi, ' ')
    .replace(/\b(?:sottoscrizione|subscription)\b/gi, ' ')
    .replace(/\b(?:cliente|client|customer|fornitore|fornitori|supplier|provider)\b/gi, ' ')
    .replace(/\b(?:quella|quello|stessa|stesso|uguale|identica|identico|come)\b/gi, ' ')
    .replace(/\b(?:sulla|sul|alla|al|della|del|dal|da|di|per|su|a)\b/gi, ' ')
    .replace(/\b(?:ora|adesso|poi|quindi|allora|invece|servizio|dominio)\b/gi, ' ')
    .replace(/[,:;!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleanTransferServiceTarget(cleaned)
}

export function parseCopySupplierExpiryToCustomerAction(message = '') {
  const text = String(message || '').trim()
  const normalized = normalizeSearchText(text)

  if (!normalized || !SUBSCRIPTION_END_DATE_TERM_PATTERN.test(normalized)) return null
  if (!SUPPLIER_SUBSCRIPTION_TERM_PATTERN.test(normalized)) return null
  if (!/\b(?:cliente|client|customer)\b/i.test(normalized)) return null

  const hasCopyVerb = new RegExp(`\\b${COPY_SUPPLIER_EXPIRY_VERBS_PATTERN}\\b`, 'i').test(
    normalized
  )
  const hasCopyRelation =
    /\b(?:come|uguale\s+a|identica\s+a|identico\s+a|a\s+quella\s+del|alla\s+stessa\s+data\s+del)\b/i.test(
      normalized
    )

  if (!hasCopyVerb && !hasCopyRelation) return null

  const selector = parseServiceListSelector(text)
  const supplierSubscriptionMatch = text.match(
    /\b(?:fornitore|supplier|provider)\b[\s\S]{0,50}?\b(?:id|numero|n\.?)\s*[:#-]?\s*([0-9a-f]{6,}(?:-[0-9a-f-]+)?)\b/i
  )
  const customerSubscriptionMatch = text.match(
    /\b(?:cliente|client|customer)\b[\s\S]{0,50}?\b(?:id|numero|n\.?)\s*[:#-]?\s*([0-9a-f]{6,}(?:-[0-9a-f-]+)?)\b/i
  )
  const namedTarget = selector ? null : cleanCopySupplierExpiryServiceTarget(text)

  return {
    type: 'renewals-copy-supplier-expiry-to-customer-request',
    tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
    message: text,
    field: 'subscriptionEndDate',
    label: 'SCADENZA CLIENTE',
    supplierSubscriptionId: supplierSubscriptionMatch?.[1] || null,
    customerSubscriptionId: customerSubscriptionMatch?.[1] || null,
    selector,
    selectorSource: selector ? 'previous-list' : namedTarget ? 'named-target' : 'context',
    namedTarget,
  }
}


function cleanPleskPlanSyncServiceTarget(value = '') {
  const cleaned = String(value || '')
    .replace(/(?:non\s+sincronizzare(?:\s+pi[uù])?|senza\s+sincronizzazione)/gi, ' ')
    .replace(/\b(?:riattiva|riattivalo|riattivala|riabilita|riabilitalo|riabilitala)\b/gi, ' ')
    .replace(new RegExp(`\\b${SET_ACTION_VERBS_PATTERN}\\b`, 'gi'), ' ')
    .replace(new RegExp(`\\b${REMOVE_ACTION_VERBS_PATTERN}\\b`, 'gi'), ' ')
    .replace(/\bno\s*sync\s+(?:del\s+)?piano\b/gi, ' ')
    .replace(
      /\b(?:sincronizzazione|sincronizza|sincronizzare|sync)\s+(?:del\s+|dello\s+|della\s+)?(?:piano|plan)(?:\s+(?:con|su))?\s+plesk\b/gi,
      ' '
    )
    .replace(/\b(?:piano|plan)(?:\s+(?:con|su))?\s+plesk\b/gi, ' ')
    .replace(/\bplesk\s+(?:piano|plan)?\s*(?:sincronizzazione|sync)\b/gi, ' ')
    .replace(/\b(?:sincronizzazione|sincronizza|sincronizzare|sync)\b/gi, ' ')
    .replace(/\b(?:piano|plan|piu)\b|più/gi, ' ')
    .replace(
      /\b(?:ora|adesso|poi|quindi|allora|invece|la|il|lo|l|un|una|del|dello|della|di|da|dal|dalla|su|sul|per|a|al|con|nel|nello|nella|servizio|dominio)\b/gi,
      ' '
    )
    .replace(/[,:;!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleanTransferServiceTarget(cleaned)
}

export function parseServicePleskPlanSyncAction(message = '') {
  const text = String(message || '').trim()
  const normalized = normalizeSearchText(text)

  if (!normalized || !PLESK_PLAN_SYNC_TERM_PATTERN.test(normalized)) return null

  const selector = parseServiceListSelector(text)
  const noSyncTerm = /\bno\s*sync\s+(?:del\s+)?piano\b/i.test(normalized)
  const explicitDisable =
    /\bnon\s+sincronizzare(?:\s+piu)?\b|\bsenza\s+sincronizzazione\b/i.test(normalized)
  const explicitEnable =
    /\b(?:riattiva|riattivalo|riattivala|riabilita|riabilitalo|riabilitala)\b/i.test(normalized)
  const remove = new RegExp(`\\b${REMOVE_ACTION_VERBS_PATTERN}\\b`, 'i').test(normalized)
  const set = new RegExp(`\\b${SET_ACTION_VERBS_PATTERN}\\b`, 'i').test(normalized)

  let desiredValue = null

  if (explicitDisable) {
    desiredValue = false
  } else if (explicitEnable) {
    desiredValue = true
  } else if (noSyncTerm) {
    if (remove && !set) desiredValue = true
    else if (set && !remove) desiredValue = false
  } else if (remove !== set) {
    desiredValue = set
  }

  if (typeof desiredValue !== 'boolean') return null

  const namedTarget = selector ? null : cleanPleskPlanSyncServiceTarget(text)

  return {
    type: 'renewals-plesk-plan-sync-request',
    tool: PLESK_PLAN_SYNC_TOOL_ID,
    message: text,
    field: 'pleskPlansSync',
    label: 'SINCRONIZZAZIONE PIANO PLESK',
    desiredValue,
    selector,
    selectorSource: selector ? 'previous-list' : namedTarget ? 'named-target' : 'context',
    namedTarget,
  }
}


export function parseServiceAuthCodeAction(message = '') {
  const text = String(message || '').trim()
  const normalized = normalizeSearchText(text)

  if (!normalized || !AUTH_CODE_TERM_PATTERN.test(normalized)) return null

  const selector = parseServiceListSelector(text)
  const remove = new RegExp(`\\b${REMOVE_ACTION_VERBS_PATTERN}\\b`, 'i').test(normalized)
  const set = new RegExp(`\\b${AUTH_CODE_SET_VERBS_PATTERN}\\b`, 'i').test(normalized)

  if (remove && !set) {
    const withoutCommand = text
      .replace(new RegExp(`\\b${REMOVE_ACTION_VERBS_PATTERN}\\b`, 'i'), ' ')
      .replace(AUTH_CODE_TERM_PATTERN, ' ')
      .replace(/\b(?:di|da|dal|dalla|del|dello|della|su|sul|per|a|al)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    const namedTarget = selector ? null : cleanAuthCodeServiceTarget(withoutCommand)

    return {
      type: 'renewals-auth-code-request',
      tool: AUTH_CODE_TOOL_ID,
      message: text,
      field: 'authCode',
      label: 'AUTH CODE',
      clear: true,
      desiredAuthCode: null,
      selector,
      selectorSource: selector ? 'previous-list' : namedTarget ? 'named-target' : 'context',
      namedTarget,
    }
  }

  const article = "(?:(?:il|lo)\\s+|l(?:['’]\\s*|\\s+))?"
  const term = AUTH_CODE_TERM_PATTERN.source
  let desiredAuthCode = null
  let namedTarget = null

  const serviceFirst = text.match(
    new RegExp(
      `\\b${AUTH_CODE_SET_VERBS_PATTERN}\\b\\s+${article}${term}\\s+(?:di|del|dello|della|per|su|sul)\\s+(.+?)\\s+(?:a|ad|in|con|come|:)\\s+(.+)$`,
      'i'
    )
  )

  if (serviceFirst?.[2]) {
    namedTarget = selector ? null : cleanAuthCodeServiceTarget(serviceFirst[1])
    desiredAuthCode = cleanAuthCodeInput(serviceFirst[2])
  }

  if (!desiredAuthCode) {
    const codeFirstWithSeparator = text.match(
      new RegExp(
        `\\b${AUTH_CODE_SET_VERBS_PATTERN}\\b\\s+${article}${term}\\s+(?:a|ad|in|con|come|:)\\s+(.+?)\\s+(?:per|su|sul|di|del|dello|della)\\s+(.+)$`,
        'i'
      )
    )

    if (codeFirstWithSeparator?.[2]) {
      desiredAuthCode = cleanAuthCodeInput(codeFirstWithSeparator[1])
      namedTarget = selector ? null : cleanAuthCodeServiceTarget(codeFirstWithSeparator[2])
    }
  }

  if (!desiredAuthCode) {
    const codeFirst = text.match(
      new RegExp(
        `\\b${AUTH_CODE_SET_VERBS_PATTERN}\\b\\s+${article}${term}\\s+(.+?)\\s+(?:per|su|sul|di|del|dello|della)\\s+(.+)$`,
        'i'
      )
    )

    if (codeFirst?.[2]) {
      desiredAuthCode = cleanAuthCodeInput(codeFirst[1])
      namedTarget = selector ? null : cleanAuthCodeServiceTarget(codeFirst[2])
    }
  }

  if (!desiredAuthCode) {
    const valueAsAuthCode = text.match(
      new RegExp(
        `\\b${AUTH_CODE_SET_VERBS_PATTERN}\\b\\s+(.+?)\\s+come\\s+${article}${term}\\s+(?:per|su|sul|di|del|dello|della)\\s+(.+)$`,
        'i'
      )
    )

    if (valueAsAuthCode?.[2]) {
      desiredAuthCode = cleanAuthCodeInput(valueAsAuthCode[1])
      namedTarget = selector ? null : cleanAuthCodeServiceTarget(valueAsAuthCode[2])
    }
  }

  if (!desiredAuthCode && set) {
    const contextual = text.match(
      new RegExp(
        `\\b${AUTH_CODE_SET_VERBS_PATTERN}\\b[\\s\\S]{0,40}${term}\\s+(?:a|ad|in|con|come|:)\\s+(.+)$`,
        'i'
      )
    )

    if (contextual?.[1]) {
      desiredAuthCode = cleanAuthCodeInput(contextual[1])
    }
  }

  if (!desiredAuthCode) {
    const declarative = text.match(
      new RegExp(
        `${term}\\s+(?:di|del|dello|della|per|su|sul)\\s+(.+?)\\s+(?:e|è|:)\\s+(.+)$`,
        'i'
      )
    )

    if (declarative?.[2]) {
      namedTarget = selector ? null : cleanAuthCodeServiceTarget(declarative[1])
      desiredAuthCode = cleanAuthCodeInput(declarative[2])
    }
  }

  if (!set && !desiredAuthCode) return null

  return {
    type: 'renewals-auth-code-request',
    tool: AUTH_CODE_TOOL_ID,
    message: redactAuthCodeMessage(text, desiredAuthCode),
    field: 'authCode',
    label: 'AUTH CODE',
    clear: false,
    desiredAuthCode,
    selector,
    selectorSource: selector ? 'previous-list' : namedTarget ? 'named-target' : 'context',
    namedTarget,
  }
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
    toTransfer: getServiceTransferProvider(service),
    invoiceDate: normalizeInvoiceDateValue(service?.invoiceDate ?? service?.invoice_date ?? null),
    pleskPlansSync: getServicePleskPlanSyncValue(service),
    hasPlesk: hasPleskService(service),
    authCodeSet: Boolean(normalizeAuthCodeValue(service?.authCode ?? service?.auth_code ?? null)),
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
    const isTransferAction = request.type === 'renewals-transfer-target-request'
    const isPleskSyncAction = request.type === 'renewals-plesk-plan-sync-request'
    const isAuthCodeAction = request.type === 'renewals-auth-code-request'
    const isSubscriptionEndDateAction =
      request.type === 'renewals-subscription-end-date-request'
    const config = getServiceFlagActionConfig(request.field)
    const label = config?.label || request.label || 'FLAG'

    let question

    if (isTransferAction) {
      question = request.clear
        ? 'Da quale servizio vuoi rimuovere DA TRASFERIRE?'
        : `Quale servizio vuoi marcare DA TRASFERIRE${
            request.providerQuery ? ` verso ${request.providerQuery}` : ''
          }?`
    } else if (isPleskSyncAction) {
      question = request.desiredValue
        ? 'Per quale servizio vuoi attivare la sincronizzazione del piano con Plesk?'
        : 'Per quale servizio vuoi disattivare la sincronizzazione del piano con Plesk?'
    } else if (isAuthCodeAction) {
      question = request.clear
        ? 'Da quale servizio vuoi rimuovere l’AUTH CODE?'
        : 'Per quale servizio vuoi impostare o sostituire l’AUTH CODE?'
    } else if (isSubscriptionEndDateAction) {
      question = `Di quale servizio vuoi modificare la ${String(request.label || 'scadenza').toLowerCase()}?`
    } else {
      question =
        request.desiredValue === true
          ? `Quale vuoi segnare come ${label}?`
          : `Da quale vuoi rimuovere ${label}?`
    }

    const rows = (resolution.candidates || []).slice(0, 8).map((candidate, index) => {
      const ids = uniqueServiceIds(candidate.item || {})

      const service = services.find(item => ids.includes(String(item?.id)))

      const details = buildCandidateDetails(service || {})
      const currentValue = details[request.field] === true
      const currentTransfer = details.toTransfer

      return [
        `${index + 1}. ${details.serviceName || 'Servizio'} (ID ${details.id || '—'})`,
        `   Cliente: ${details.customerName || '—'}`,
        `   Gruppo: ${details.groupName || '—'}`,
        `   Piano cliente: ${details.customerPlan || '—'}`,
        `   Fornitore: ${details.suppliers.join(', ') || '—'}`,
        `   Scadenza cliente: ${details.customerExpiry || '—'}`,
        `   Scadenza fornitore: ${details.supplierExpiry || '—'}`,
        isTransferAction
          ? `   DA TRASFERIRE: ${currentTransfer ? providerLabel(currentTransfer) : 'non impostato'}`
          : isPleskSyncAction
            ? `   Plesk: ${details.hasPlesk ? 'collegato' : 'non collegato'} | Sincronizzazione piano: ${details.pleskPlansSync ? 'attiva' : 'disattivata'}`
            : isAuthCodeAction
              ? `   AUTH CODE: ${details.authCodeSet ? 'presente' : 'non presente'}`
              : `   Stato attuale: ${label} ${currentValue ? 'attivo' : 'non attivo'}`,
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


function getSubscriptionId(subscription = {}) {
  return subscription?.id ? String(subscription.id) : null
}

function getSubscriptionIsSupplier(subscription = {}) {
  return subscription?.isSupplier === true || subscription?.is_supplier_subscription === true
}

function getSubscriptionStartDate(subscription = {}) {
  return normalizeInvoiceDateValue(subscription?.startsOn ?? subscription?.starts_on ?? null)
}

function getSubscriptionEndDate(subscription = {}) {
  return normalizeInvoiceDateValue(subscription?.endsOn ?? subscription?.ends_on ?? null)
}

function getSubscriptionPlanName(subscription = {}) {
  return subscription?.plan?.name || subscription?.plans_id?.name || null
}

function getSubscriptionSupplierName(subscription = {}) {
  return (
    subscription?.plan?.supplier?.name ||
    subscription?.plans_id?.suppliers_id?.name ||
    null
  )
}

function collectServiceSubscriptions(service = {}) {
  const out = []
  const seen = new Set()

  const visit = subscription => {
    if (!subscription) return

    const id = getSubscriptionId(subscription)

    if (id && !seen.has(id)) {
      seen.add(id)
      out.push(subscription)
    }

    const children =
      subscription?.suppliersSubscriptions ||
      subscription?.suppliers_subscriptions ||
      subscription?.suppliersSubscriptionsChildren ||
      []

    for (const child of Array.isArray(children) ? children : []) {
      visit(child?.related_subscriptions_id || child)
    }
  }

  for (const subscription of Array.isArray(service?.subscriptions) ? service.subscriptions : []) {
    visit(subscription)
  }

  return out
}

function findServiceSubscription(service = {}, subscriptionId) {
  const targetId = String(subscriptionId || '').trim()

  if (!targetId) return null

  return (
    collectServiceSubscriptions(service).find(
      subscription => getSubscriptionId(subscription) === targetId
    ) || null
  )
}

function subscriptionTypeLabel(subscription = {}) {
  return getSubscriptionIsSupplier(subscription) ? 'fornitore' : 'cliente'
}

function buildSubscriptionReference(subscription = {}) {
  return {
    id: getSubscriptionId(subscription),
    type: getSubscriptionIsSupplier(subscription) ? 'supplier' : 'customer',
    label: getSubscriptionIsSupplier(subscription)
      ? 'Sottoscrizione fornitore'
      : 'Sottoscrizione cliente',
    planName: getSubscriptionPlanName(subscription),
    supplierName: getSubscriptionSupplierName(subscription),
    startsOn: getSubscriptionStartDate(subscription),
    endsOn: getSubscriptionEndDate(subscription),
  }
}

function buildSubscriptionChoiceLine(subscription = {}, index = 0) {
  const ref = buildSubscriptionReference(subscription)

  return [
    `${index + 1}. ${ref.label} (ID ${ref.id || '—'})`,
    `   Piano: ${ref.planName || '—'}`,
    `   Fornitore: ${ref.supplierName || '—'}`,
    `   Inizio: ${ref.startsOn ? formatInvoiceDate(ref.startsOn) : '—'}`,
    `   Scadenza: ${ref.endsOn ? formatInvoiceDate(ref.endsOn) : '—'}`,
  ].join('\n')
}

function resolveSubscriptionForRequest(service = {}, request = {}) {
  const expectedSupplier = request.subscriptionType === 'supplier'
  const candidates = collectServiceSubscriptions(service).filter(
    subscription => getSubscriptionIsSupplier(subscription) === expectedSupplier
  )

  if (request.subscriptionId) {
    const explicit = candidates.find(
      subscription => getSubscriptionId(subscription) === String(request.subscriptionId)
    )

    return explicit
      ? {status: 'resolved', subscription: explicit, candidates}
      : {status: 'not-found', candidates}
  }

  if (!candidates.length) return {status: 'empty', candidates}
  if (candidates.length === 1) return {status: 'resolved', subscription: candidates[0], candidates}

  return {status: 'ambiguous', candidates}
}


function getServicePleskPlanSyncValue(service = {}) {
  const raw = service?.pleskPlansSync ?? service?.plesk_plans_sync

  return raw !== false
}

function hasPleskService(service = {}) {
  if (service?.pleskDomain?.id || service?.plesk_domain?.id) return true

  const relation = service?.domains_id?.plesk_domain

  if (Array.isArray(relation)) {
    return relation.some(item => Boolean(item?.id || item))
  }

  return Boolean(relation?.id || relation)
}


function getServiceTransferProvider(service = {}) {
  const raw = service?.toTransfer ?? service?.to_transfer ?? null

  if (!raw) return null

  if (typeof raw === 'object') {
    const id = raw?.id ? String(raw.id) : null

    return id
      ? {
          id,
          name: raw?.name || null,
        }
      : null
  }

  const id = String(raw).trim()

  return id
    ? {
        id,
        name: null,
      }
    : null
}

function normalizeProviderOption(option = {}) {
  const id = option?.value ?? option?.id ?? null
  const name = option?.label ?? option?.name ?? null

  return id
    ? {
        id: String(id),
        name: name ? String(name) : null,
      }
    : null
}

function providerLabel(provider = null) {
  return provider?.name || provider?.id || 'nessun fornitore'
}

function normalizeProviderSearch(value = '') {
  return normalizeComparable(value)
}

function resolveTransferProvider(providerQuery = '', providers = []) {
  const query = String(providerQuery || '').trim()

  if (!query) {
    return {
      status: 'missing-provider',
    }
  }

  const options = providers.map(normalizeProviderOption).filter(Boolean)
  const directId = options.find(provider => provider.id === query)

  if (directId) {
    return {
      status: 'resolved',
      provider: directId,
    }
  }

  const normalizedQuery = normalizeProviderSearch(query)

  const exact = options.filter(
    provider => normalizeProviderSearch(provider.name || '') === normalizedQuery
  )

  if (exact.length === 1) {
    return {
      status: 'resolved',
      provider: exact[0],
    }
  }

  const partial = options.filter(provider => {
    const normalizedName = normalizeProviderSearch(provider.name || '')

    return normalizedName && normalizedName.includes(normalizedQuery)
  })

  if (partial.length === 1) {
    return {
      status: 'resolved',
      provider: partial[0],
    }
  }

  const candidates = exact.length > 1 ? exact : partial

  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      term: query,
      candidates,
    }
  }

  return {
    status: 'not-found',
    term: query,
  }
}

function sameProvider(first = null, second = null) {
  return String(first?.id || '') === String(second?.id || '')
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

function getCurrentActionValues(service = {}, operation = 'service-flags', resource = null) {
  if (operation === 'transfer-target') {
    return {
      toTransfer: getServiceTransferProvider(service)?.id || null,
    }
  }

  if (operation === 'invoice-date') {
    return {
      invoiceDate: normalizeInvoiceDateValue(service?.invoiceDate ?? service?.invoice_date ?? null),
    }
  }

  if (operation === 'plesk-plan-sync') {
    return {
      pleskPlansSync: getServicePleskPlanSyncValue(service),
    }
  }

  if (operation === 'auth-code') {
    return {
      authCode: normalizeAuthCodeValue(service?.authCode ?? service?.auth_code ?? null),
    }
  }

  if (operation === 'subscription-end-date') {
    const subscription = findServiceSubscription(service, resource?.id)

    return {
      subscriptionEndDate: subscription ? getSubscriptionEndDate(subscription) : undefined,
    }
  }

  return {
    dontRenew: getServiceFlagValue(service, 'dontRenew'),
    autoRenew: getServiceFlagValue(service, 'autoRenew'),
    toRenew: getServiceFlagValue(service, 'toRenew'),
  }
}

function sameActionValue(field, first, second) {
  if (field === 'toTransfer') {
    return String(first || '') === String(second || '')
  }

  if (field === 'invoiceDate' || field === 'subscriptionEndDate') {
    return normalizeInvoiceDateValue(first) === normalizeInvoiceDateValue(second)
  }

  if (field === 'authCode') {
    return normalizeAuthCodeValue(first) === normalizeAuthCodeValue(second)
  }

  return first === second
}

function buildUndoChanges(completed = {}) {
  const beforeValues = completed.beforeValues || completed.beforeFlags || {}
  const afterValues = completed.afterValues || completed.afterFlags || {}
  const fields = Object.keys(afterValues)

  return fields
    .filter(field => !sameActionValue(field, afterValues[field], beforeValues[field]))
    .map(field => {
      if (field === 'toTransfer') {
        const originalChange = (completed.changes || []).find(change => change.field === field)

        return buildChange(
          field,
          'DA TRASFERIRE',
          originalChange?.to || (afterValues[field] ? {id: afterValues[field], name: null} : null),
          originalChange?.from || (beforeValues[field] ? {id: beforeValues[field], name: null} : null)
        )
      }

      if (field === 'invoiceDate') {
        return buildChange(
          field,
          'DATA DI FATTURAZIONE',
          afterValues[field] || null,
          beforeValues[field] || null
        )
      }

      if (field === 'subscriptionEndDate') {
        const label =
          completed.subscription?.type === 'supplier'
            ? 'SCADENZA FORNITORE'
            : 'SCADENZA CLIENTE'

        return buildChange(
          field,
          label,
          afterValues[field] || null,
          beforeValues[field] || null
        )
      }

      if (field === 'pleskPlansSync') {
        return buildChange(
          field,
          'SINCRONIZZAZIONE PIANO PLESK',
          afterValues[field] === true,
          beforeValues[field] === true
        )
      }

      if (field === 'authCode') {
        return buildAuthCodeChange(afterValues[field], beforeValues[field])
      }

      return buildChange(
        field,
        SERVICE_FLAG_LABELS[field] || field,
        afterValues[field],
        beforeValues[field]
      )
    })
}

function describeTransferChange(change = {}, {completed = false} = {}) {
  const destination = change?.to ? providerLabel(change.to) : null

  if (destination) {
    return completed
      ? `DA TRASFERIRE impostato verso ${destination}`
      : `imposterò DA TRASFERIRE verso ${destination}`
  }

  const previous = change?.from ? ` (${providerLabel(change.from)})` : ''

  return completed
    ? `DA TRASFERIRE rimosso${previous}`
    : `rimuoverò DA TRASFERIRE${previous}`
}

function describePlannedChanges(changes = []) {
  return joinItalian(
    changes.map(change => {
      if (change.field === 'toTransfer') return describeTransferChange(change)
      if (change.field === 'invoiceDate') {
        return change.to
          ? `imposterò la DATA DI FATTURAZIONE al ${formatInvoiceDate(change.to)}`
          : `rimuoverò la DATA DI FATTURAZIONE${change.from ? ` del ${formatInvoiceDate(change.from)}` : ''}`
      }
      if (change.field === 'subscriptionEndDate') {
        return change.to
          ? `imposterò la ${change.label} al ${formatInvoiceDate(change.to)}`
          : `rimuoverò la ${change.label}${change.from ? ` del ${formatInvoiceDate(change.from)}` : ''}`
      }
      if (change.field === 'pleskPlansSync') {
        return change.to
          ? 'attiverò la SINCRONIZZAZIONE DEL PIANO CON PLESK'
          : 'disattiverò la SINCRONIZZAZIONE DEL PIANO CON PLESK'
      }
      if (change.field === 'authCode') {
        if (change.to?.isSet && change.from?.isSet) return 'sostituirò l’AUTH CODE attualmente presente'
        if (change.to?.isSet) return 'imposterò l’AUTH CODE'
        return 'rimuoverò l’AUTH CODE attualmente presente'
      }
      return change.to ? `attiverò ${change.label}` : `disattiverò ${change.label}`
    })
  )
}

function describeCompletedChanges(changes = []) {
  return joinItalian(
    changes.map(change => {
      if (change.field === 'toTransfer') return describeTransferChange(change, {completed: true})
      if (change.field === 'invoiceDate') {
        return change.to
          ? `DATA DI FATTURAZIONE impostata al ${formatInvoiceDate(change.to)}`
          : `DATA DI FATTURAZIONE rimossa${change.from ? ` (era ${formatInvoiceDate(change.from)})` : ''}`
      }
      if (change.field === 'subscriptionEndDate') {
        return change.to
          ? `${change.label} impostata al ${formatInvoiceDate(change.to)}`
          : `${change.label} rimossa${change.from ? ` (era ${formatInvoiceDate(change.from)})` : ''}`
      }
      if (change.field === 'pleskPlansSync') {
        return change.to
          ? 'SINCRONIZZAZIONE DEL PIANO CON PLESK attivata'
          : 'SINCRONIZZAZIONE DEL PIANO CON PLESK disattivata'
      }
      if (change.field === 'authCode') {
        if (change.to?.isSet && change.from?.isSet) return 'AUTH CODE sostituito'
        if (change.to?.isSet) return 'AUTH CODE impostato'
        return 'AUTH CODE rimosso'
      }
      return change.to ? `${change.label} attivato` : `${change.label} disattivato`
    })
  )
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

  const operation = completed.operation || 'service-flags'
  const beforeValues = completed.beforeValues || completed.beforeFlags || {}
  const afterValues = completed.afterValues || completed.afterFlags || {}

  if (operation === 'service-flags' && !isCoherentServiceFlagState(beforeValues)) {
    return buildUndoUnavailableResponse(
      'action-undo-invalid-previous-state',
      'Non posso ripristinare lo stato precedente perché non rispetta più le regole di coerenza tra i flag.'
    )
  }

  if (operation === 'subscription-end-date' && !findServiceSubscription(service, completed.subscription?.id)) {
    return buildUndoUnavailableResponse(
      'action-undo-subscription-not-found',
      'La sottoscrizione dell’ultima operazione non è più disponibile.'
    )
  }

  const currentValues = getCurrentActionValues(service, operation, completed.subscription)
  const fields = Object.keys(afterValues)

  const staleFields = fields.filter(
    field => !sameActionValue(field, currentValues[field], afterValues[field])
  )

  if (staleFields.length) {
    return buildUndoUnavailableResponse(
      'action-undo-state-changed',
      'Lo stato del servizio è cambiato dopo l’ultima operazione. Per sicurezza non posso annullarla automaticamente.'
    )
  }

  const changes = buildUndoChanges(completed)

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

  const expectedValues =
    operation === 'auth-code'
      ? {authCode: normalizeAuthCodeValue(afterValues.authCode)}
      : Object.fromEntries(
          changes.map(change => [
            change.field,
            change.field === 'toTransfer' ? change.from?.id || null : change.from,
          ])
        )

  const desiredValues =
    operation === 'auth-code'
      ? {authCode: normalizeAuthCodeValue(beforeValues.authCode)}
      : Object.fromEntries(
          changes.map(change => [
            change.field,
            change.field === 'toTransfer' ? change.to?.id || null : change.to,
          ])
        )

  const proposal = {
    actionId,
    tool:
      operation === 'transfer-target'
        ? TRANSFER_TOOL_ID
        : operation === 'invoice-date'
          ? INVOICE_DATE_TOOL_ID
          : operation === 'plesk-plan-sync'
            ? PLESK_PLAN_SYNC_TOOL_ID
            : operation === 'auth-code'
              ? AUTH_CODE_TOOL_ID
              : operation === 'subscription-end-date'
                ? SUBSCRIPTION_END_DATE_TOOL_ID
                : TOOL_ID,
    operation,

    kind: 'undo',
    undoOfActionId: completed.actionId,

    status: 'pending',
    actorFingerprint,

    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,

    target: completed.target,
    subscription: completed.subscription ? {...completed.subscription} : null,
    changes,

    field: null,
    label: 'RIPRISTINO STATO PRECEDENTE',
    requestedValue: null,

    expectedValues,
    desiredValues,
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
      `${describePlannedChanges(changes)}. Confermi?`,

    data: {
      type: 'action-preview',

      action: {
        actionId,
        tool: proposal.tool,
        kind: 'undo',
        undoOfActionId: completed.actionId,

        requiresConfirmation: true,

        expiresAt: new Date(proposal.expiresAt).toISOString(),

        target: proposal.target,
        subscription: proposal.subscription || null,
        changes,
      },
    },

    meta: buildActionMeta('action-proposal', {
      tool: proposal.tool,
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

function rememberPendingClarification({request, resolution, services, providers = [], scope, actorToken}) {
  const actorFingerprint = fingerprintToken(actorToken)

  const candidateIds = (resolution?.candidates || [])
    .flatMap(candidate => uniqueServiceIds(candidate?.item || {}))
    .filter(id => services.some(service => String(service?.id) === String(id)))

  if (!candidateIds.length) return

  pendingClarifications.set(actorFingerprint, {
    kind: 'service',
    request,
    scope,
    providers: Array.isArray(providers) ? providers : [],
    candidateIds: [...new Set(candidateIds.map(String))],
    createdAt: Date.now(),
    expiresAt: Date.now() + PROPOSAL_TTL_MS,
  })
}

function rememberPendingProviderClarification({
  request,
  providerResolution,
  scope,
  actorToken,
}) {
  const candidates = (providerResolution?.candidates || []).map(normalizeProviderOption).filter(Boolean)

  if (!candidates.length) return

  pendingClarifications.set(fingerprintToken(actorToken), {
    kind: 'provider',
    request,
    scope,
    providers: candidates,
    createdAt: Date.now(),
    expiresAt: Date.now() + PROPOSAL_TTL_MS,
  })
}

function rememberPendingSubscriptionClarification({
  request,
  service,
  candidates = [],
  scope,
  actorToken,
}) {
  const subscriptionIds = candidates.map(getSubscriptionId).filter(Boolean)

  if (!service?.id || !subscriptionIds.length) return

  pendingClarifications.set(fingerprintToken(actorToken), {
    kind: 'subscription',
    request,
    scope: {
      ...scope,
      serviceId: String(service.id),
    },
    serviceId: String(service.id),
    subscriptionIds,
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

function resolvePendingProvider(message = '', candidates = []) {
  const raw = String(message || '').trim()
  const ordinalIndex = extractOrdinalIndex(raw)

  if (ordinalIndex >= 0 && ordinalIndex < candidates.length) {
    return {
      status: 'resolved',
      provider: candidates[ordinalIndex],
    }
  }

  return resolveTransferProvider(raw, candidates)
}

function resolvePendingSubscription(message = '', service = {}, subscriptionIds = []) {
  const candidates = subscriptionIds
    .map(id => findServiceSubscription(service, id))
    .filter(Boolean)

  if (!candidates.length) return {status: 'not-found'}

  const raw = String(message || '').trim()
  const ordinalIndex = extractOrdinalIndex(raw)

  if (ordinalIndex >= 0 && ordinalIndex < candidates.length) {
    return {status: 'resolved', subscription: candidates[ordinalIndex]}
  }

  const exactId = candidates.find(subscription => getSubscriptionId(subscription) === raw)
  if (exactId) return {status: 'resolved', subscription: exactId}

  const normalized = normalizeComparable(raw)
    .replace(
      /\b(quella|quello|sottoscrizione|subscription|con|il|lo|la|l|fornitore|piano|cliente|che|ha|scade|scadenza)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return {status: 'unrecognized'}

  const matched = candidates.filter(subscription => {
    const ref = buildSubscriptionReference(subscription)
    const haystack = normalizeComparable(
      [ref.id, ref.planName, ref.supplierName, ref.startsOn, ref.endsOn, ref.type]
        .filter(Boolean)
        .join(' ')
    )

    return haystack.includes(normalized)
  })

  if (matched.length === 1) return {status: 'resolved', subscription: matched[0]}
  if (matched.length > 1) return {status: 'ambiguous', candidates: matched}

  return {status: 'not-found'}
}


export function hasPendingRenewalsActionClarification({actorToken = ''} = {}) {
  cleanupPendingClarifications()

  return pendingClarifications.has(fingerprintToken(actorToken))
}

export function handlePendingRenewalsActionClarification({
  message = '',
  services = [],
  providers = [],
  settings = {},
  history = [],
  scope = {},
  actorToken = '',
} = {}) {
  cleanupPendingClarifications()

  const actorFingerprint = fingerprintToken(actorToken)
  const pending = pendingClarifications.get(actorFingerprint)

  if (!pending) return null

  if (pending.kind === 'subscription') {
    const service = services.find(item => String(item?.id) === String(pending.serviceId))

    if (!service) {
      pendingClarifications.delete(actorFingerprint)

      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: 'Il servizio selezionato non è più disponibile. Ripeti la richiesta.',
        data: {type: 'clarification', reason: 'action-subscription-service-not-found'},
        meta: buildActionMeta('clarification', {
          tool: pending.request?.tool || SUBSCRIPTION_END_DATE_TOOL_ID,
          guard: 'action-subscription-service-not-found',
        }),
      }
    }

    const selection = resolvePendingSubscription(
      message,
      service,
      pending.subscriptionIds || []
    )

    if (selection.status === 'unrecognized') return null

    if (selection.status !== 'resolved') {
      const candidates = (pending.subscriptionIds || [])
        .map(id => findServiceSubscription(service, id))
        .filter(Boolean)

      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: [
          selection.status === 'ambiguous'
            ? 'Il dettaglio indicato corrisponde ancora a più sottoscrizioni.'
            : 'Non riesco a identificare una delle sottoscrizioni proposte.',
          'Indica il numero, l’ID, il piano, il fornitore oppure la scadenza attuale:',
          '',
          ...candidates.map(buildSubscriptionChoiceLine),
        ].join('\n'),
        data: {
          type: 'clarification',
          reason: `action-subscription-${selection.status || 'unresolved'}`,
        },
        meta: buildActionMeta('clarification', {
          tool: pending.request?.tool || SUBSCRIPTION_END_DATE_TOOL_ID,
          guard: `action-subscription-${selection.status || 'unresolved'}`,
        }),
      }
    }

    pendingClarifications.delete(actorFingerprint)

    if (pending.request?.type === 'renewals-copy-supplier-expiry-to-customer-request') {
      const selectedId = getSubscriptionId(selection.subscription)
      const role = pending.request?.clarificationRole || 'supplier'

      return buildCopySupplierExpiryToCustomerActionPreview({
        request: {
          ...pending.request,
          selector: null,
          selectorSource: 'context',
          namedTarget: null,
          clarificationRole: null,
          ...(role === 'customer'
            ? {customerSubscriptionId: selectedId}
            : {supplierSubscriptionId: selectedId}),
        },
        services,
        settings,
        history,
        scope: {
          ...pending.scope,
          ...scope,
          serviceId: service.id,
        },
        actorToken,
      })
    }

    return buildServiceSubscriptionEndDateActionPreview({
      request: {
        ...pending.request,
        selector: null,
        selectorSource: 'context',
        namedTarget: null,
        subscriptionId: getSubscriptionId(selection.subscription),
      },
      services,
      settings,
      history,
      scope: {
        ...pending.scope,
        ...scope,
        serviceId: service.id,
      },
      actorToken,
    })
  }

  if (pending.kind === 'provider') {
    const selection = resolvePendingProvider(message, pending.providers || [])

    if (selection.status !== 'resolved') {
      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: [
          'Non riesco a identificare un solo fornitore di destinazione.',
          'Indica il numero, l’ID oppure il nome completo:',
          '',
          ...(pending.providers || []).map(
            (provider, index) => `${index + 1}. ${providerLabel(provider)} (ID ${provider.id})`
          ),
        ].join('\n'),
        data: {
          type: 'clarification',
          reason: `action-provider-${selection.status || 'unresolved'}`,
        },
        meta: buildActionMeta('clarification', {
          tool: TRANSFER_TOOL_ID,
          guard: `action-provider-${selection.status || 'unresolved'}`,
        }),
      }
    }

    pendingClarifications.delete(actorFingerprint)

    return buildServiceTransferTargetActionPreview({
      request: {
        ...pending.request,
        providerQuery: selection.provider.id,
      },
      services,
      providers: pending.providers || providers,
      settings,
      history,
      scope: {
        ...pending.scope,
        ...scope,
      },
      actorToken,
    })
  }

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
        tool: pending.request?.tool || TOOL_ID,
        guard: `action-target-${selection.status}`,
      }),
    }
  }

  pendingClarifications.delete(actorFingerprint)

  const previewArgs = {
    request: {
      ...pending.request,
      selector: null,
      selectorSource: 'context',
      namedTarget: null,
    },
    services,
    providers: pending.providers || providers,
    settings,
    history,
    scope: {
      ...pending.scope,
      ...scope,
      serviceId: selection.service.id,
    },
    actorToken,
  }

  if (pending.request?.type === 'renewals-transfer-target-request') {
    return buildServiceTransferTargetActionPreview(previewArgs)
  }

  if (pending.request?.type === 'renewals-invoice-date-request') {
    return buildServiceInvoiceDateActionPreview(previewArgs)
  }

  if (pending.request?.type === 'renewals-plesk-plan-sync-request') {
    return buildServicePleskPlanSyncActionPreview(previewArgs)
  }

  if (pending.request?.type === 'renewals-auth-code-request') {
    return buildServiceAuthCodeActionPreview(previewArgs)
  }

  if (pending.request?.type === 'renewals-subscription-end-date-request') {
    return buildServiceSubscriptionEndDateActionPreview(previewArgs)
  }

  if (pending.request?.type === 'renewals-copy-supplier-expiry-to-customer-request') {
    return buildCopySupplierExpiryToCustomerActionPreview(previewArgs)
  }

  return buildServiceFlagActionPreview(previewArgs)
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
        scope: resolvedScope,
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
  const target = {
    type: 'service',
    id: String(service.id),
    label: getServiceLabel(service),
  }

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
    operation: 'service-flags',
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
    expectedValues: mutationPlan.expectedFlags,
    desiredValues: mutationPlan.desiredFlags,
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


export function buildServiceInvoiceDateActionPreview({
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
      ? resolveFromPreviousList({request, services, settings, history, scope: resolvedScope, message: request.message || ''})
      : request.selectorSource === 'named-target'
        ? resolveNamedTarget({request, services, scope: resolvedScope})
        : resolveContextTarget({services, scope: resolvedScope})

  if (resolution.status !== 'resolved') {
    if (resolution.status === 'ambiguous') {
      rememberPendingClarification({request, resolution, services, scope: resolvedScope, actorToken})
    }

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildResolutionClarification(resolution, services, request),
      data: {type: 'clarification', reason: `action-target-${resolution.status || 'unresolved'}`},
      meta: buildActionMeta('clarification', {tool: INVOICE_DATE_TOOL_ID, guard: `action-target-${resolution.status || 'unresolved'}`}),
    }
  }

  const resolvedService = findResolvedService(services, resolution.item)
  if (resolvedService.status !== 'resolved') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: resolvedService.status === 'grouped-row'
        ? 'La riga selezionata raggruppa più servizi. Indica il singolo servizio di cui vuoi modificare la data di fatturazione.'
        : 'Il servizio selezionato non è più disponibile. Ripeti la ricerca prima di procedere.',
      data: {type: 'clarification', reason: `action-target-${resolvedService.status}`},
      meta: buildActionMeta('clarification', {tool: INVOICE_DATE_TOOL_ID, guard: `action-target-${resolvedService.status}`}),
    }
  }

  const service = resolvedService.service
  const target = {type: 'service', id: String(service.id), label: getServiceLabel(service)}
  rememberRecentActionTarget(actorToken, target)

  const currentDate = normalizeInvoiceDateValue(service?.invoiceDate ?? service?.invoice_date ?? null)
  const desiredDate = request.clear ? null : normalizeInvoiceDateValue(request.desiredDate)

  if (!request.clear && !desiredDate) {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: 'Indica una data valida, ad esempio “15 settembre 2026” oppure “15/09/2026”.',
      data: {type: 'clarification', reason: 'action-invoice-date-invalid'},
      meta: buildActionMeta('clarification', {tool: INVOICE_DATE_TOOL_ID, guard: 'action-invoice-date-invalid'}),
    }
  }

  if (currentDate === desiredDate) {
    return {
      ok: true,
      intent: 'action-result',
      source: 'tool-fast',
      reply: desiredDate
        ? `Il servizio "${target.label}" ha già la data di fatturazione impostata al ${formatInvoiceDate(desiredDate)}.`
        : `Il servizio "${target.label}" non ha una data di fatturazione impostata.`,
      data: {type: 'action-result', action: {tool: INVOICE_DATE_TOOL_ID, requiresConfirmation: false, target, changes: []}, result: {status: 'noop', changed: false}},
      meta: buildActionMeta('action-result', {tool: INVOICE_DATE_TOOL_ID, actionStatus: 'noop'}),
    }
  }

  const changes = [buildChange('invoiceDate', 'DATA DI FATTURAZIONE', currentDate, desiredDate)]
  const now = Date.now()
  const actionId = randomUUID()
  const actorFingerprint = fingerprintToken(actorToken)
  supersedePendingProposals(actorFingerprint)

  const proposal = {
    actionId,
    tool: INVOICE_DATE_TOOL_ID,
    operation: 'invoice-date',
    status: 'pending',
    actorFingerprint,
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
    target,
    changes,
    field: 'invoiceDate',
    label: 'DATA DI FATTURAZIONE',
    requestedValue: desiredDate,
    expectedValues: {invoiceDate: currentDate},
    desiredValues: {invoiceDate: desiredDate},
  }

  proposals.set(actionId, proposal)
  auditAction('proposed', proposal)

  return {
    ok: true,
    intent: 'action-proposal',
    source: 'tool-fast',
    reply: `Sul servizio "${target.label}" ${describePlannedChanges(changes)}. Confermi?`,
    data: {type: 'action-preview', action: {actionId, tool: INVOICE_DATE_TOOL_ID, requiresConfirmation: true, expiresAt: new Date(proposal.expiresAt).toISOString(), target, changes}},
    meta: buildActionMeta('action-proposal', {tool: INVOICE_DATE_TOOL_ID, actionId, actionStatus: 'pending'}),
  }
}


export function buildServiceSubscriptionEndDateActionPreview({
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
        ? resolveNamedTarget({request, services, scope: resolvedScope})
        : resolveContextTarget({services, scope: resolvedScope})

  if (resolution.status !== 'resolved') {
    if (resolution.status === 'ambiguous') {
      rememberPendingClarification({
        request,
        resolution,
        services,
        scope: resolvedScope,
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
        tool: SUBSCRIPTION_END_DATE_TOOL_ID,
        guard: `action-target-${resolution.status || 'unresolved'}`,
      }),
    }
  }

  const resolvedService = findResolvedService(services, resolution.item)

  if (resolvedService.status !== 'resolved') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply:
        resolvedService.status === 'grouped-row'
          ? 'La riga selezionata raggruppa più servizi. Indica il singolo servizio di cui vuoi modificare la scadenza.'
          : 'Il servizio selezionato non è più disponibile. Ripeti la ricerca prima di procedere.',
      data: {
        type: 'clarification',
        reason: `action-target-${resolvedService.status}`,
      },
      meta: buildActionMeta('clarification', {
        tool: SUBSCRIPTION_END_DATE_TOOL_ID,
        guard: `action-target-${resolvedService.status}`,
      }),
    }
  }

  const service = resolvedService.service
  const target = {
    type: 'service',
    id: String(service.id),
    label: getServiceLabel(service),
  }

  rememberRecentActionTarget(actorToken, target)

  const desiredDate = normalizeInvoiceDateValue(request.desiredDate)

  if (!desiredDate) {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: 'Indica una data valida, ad esempio “3 marzo 2028” oppure “03/03/2028”.',
      data: {type: 'clarification', reason: 'action-subscription-end-date-invalid'},
      meta: buildActionMeta('clarification', {
        tool: SUBSCRIPTION_END_DATE_TOOL_ID,
        guard: 'action-subscription-end-date-invalid',
      }),
    }
  }

  const subscriptionResolution = resolveSubscriptionForRequest(service, request)
  const typeLabel = request.subscriptionType === 'supplier' ? 'fornitore' : 'cliente'

  if (subscriptionResolution.status === 'empty') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: `Il servizio "${target.label}" non ha sottoscrizioni ${typeLabel} disponibili.`,
      data: {type: 'clarification', reason: 'action-subscription-not-found'},
      meta: buildActionMeta('clarification', {
        tool: SUBSCRIPTION_END_DATE_TOOL_ID,
        guard: 'action-subscription-not-found',
      }),
    }
  }

  if (subscriptionResolution.status === 'not-found') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: `Non ho trovato la sottoscrizione ${typeLabel} indicata sul servizio "${target.label}".`,
      data: {type: 'clarification', reason: 'action-subscription-id-not-found'},
      meta: buildActionMeta('clarification', {
        tool: SUBSCRIPTION_END_DATE_TOOL_ID,
        guard: 'action-subscription-id-not-found',
      }),
    }
  }

  if (subscriptionResolution.status === 'ambiguous') {
    rememberPendingSubscriptionClarification({
      request,
      service,
      candidates: subscriptionResolution.candidates,
      scope: resolvedScope,
      actorToken,
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: [
        `Il servizio "${target.label}" ha più sottoscrizioni ${typeLabel}.`,
        `Quale vuoi portare al ${formatInvoiceDate(desiredDate)}?`,
        '',
        ...subscriptionResolution.candidates.map(buildSubscriptionChoiceLine),
        '',
        'Rispondi con il numero, l’ID, il piano, il fornitore oppure la scadenza attuale.',
      ].join('\n'),
      data: {type: 'clarification', reason: 'action-subscription-ambiguous'},
      meta: buildActionMeta('clarification', {
        tool: SUBSCRIPTION_END_DATE_TOOL_ID,
        guard: 'action-subscription-ambiguous',
      }),
    }
  }

  const subscription = subscriptionResolution.subscription
  const subscriptionRef = buildSubscriptionReference(subscription)
  const currentDate = subscriptionRef.endsOn
  const startsOn = subscriptionRef.startsOn

  if (startsOn && desiredDate.slice(0, 10) < startsOn.slice(0, 10)) {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply:
        `La nuova scadenza (${formatInvoiceDate(desiredDate)}) precede l’inizio della sottoscrizione ` +
        `(${formatInvoiceDate(startsOn)}). Indica una data uguale o successiva all’inizio.`,
      data: {type: 'clarification', reason: 'action-subscription-end-before-start'},
      meta: buildActionMeta('clarification', {
        tool: SUBSCRIPTION_END_DATE_TOOL_ID,
        guard: 'action-subscription-end-before-start',
      }),
    }
  }

  if (currentDate === desiredDate) {
    return {
      ok: true,
      intent: 'action-result',
      source: 'tool-fast',
      reply:
        `La sottoscrizione ${subscriptionTypeLabel(subscription)} del servizio "${target.label}" ` +
        `scade già il ${formatInvoiceDate(desiredDate)}.`,
      data: {
        type: 'action-result',
        action: {
          tool: SUBSCRIPTION_END_DATE_TOOL_ID,
          requiresConfirmation: false,
          target,
          subscription: subscriptionRef,
          changes: [],
        },
        result: {status: 'noop', changed: false},
      },
      meta: buildActionMeta('action-result', {
        tool: SUBSCRIPTION_END_DATE_TOOL_ID,
        actionStatus: 'noop',
      }),
    }
  }

  const label =
    subscriptionRef.type === 'supplier' ? 'SCADENZA FORNITORE' : 'SCADENZA CLIENTE'
  const changes = [
    buildChange('subscriptionEndDate', label, currentDate, desiredDate),
  ]
  const now = Date.now()
  const actionId = randomUUID()
  const actorFingerprint = fingerprintToken(actorToken)

  supersedePendingProposals(actorFingerprint)

  const proposal = {
    actionId,
    tool: SUBSCRIPTION_END_DATE_TOOL_ID,
    operation: 'subscription-end-date',
    status: 'pending',
    actorFingerprint,
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
    target,
    subscription: subscriptionRef,
    changes,
    field: 'subscriptionEndDate',
    label,
    requestedValue: desiredDate,
    expectedValues: {subscriptionEndDate: currentDate},
    desiredValues: {subscriptionEndDate: desiredDate},
  }

  proposals.set(actionId, proposal)
  auditAction('proposed', proposal, {subscription: subscriptionRef})

  return {
    ok: true,
    intent: 'action-proposal',
    source: 'tool-fast',
    reply:
      `Sul servizio "${target.label}" modificherò la scadenza della sottoscrizione ` +
      `${subscriptionRef.type === 'supplier' ? 'fornitore' : 'cliente'} ` +
      `(ID ${subscriptionRef.id}${subscriptionRef.planName ? `, piano ${subscriptionRef.planName}` : ''}) ` +
      `dal ${currentDate ? formatInvoiceDate(currentDate) : 'non impostata'} ` +
      `al ${formatInvoiceDate(desiredDate)}. La modifica riguarda solo la scadenza nel CRM e non rinnova il servizio né aggiorna automaticamente Plesk o altri sistemi. Confermi?`,
    data: {
      type: 'action-preview',
      action: {
        actionId,
        tool: SUBSCRIPTION_END_DATE_TOOL_ID,
        requiresConfirmation: true,
        expiresAt: new Date(proposal.expiresAt).toISOString(),
        target,
        subscription: subscriptionRef,
        changes,
      },
    },
    meta: buildActionMeta('action-proposal', {
      tool: SUBSCRIPTION_END_DATE_TOOL_ID,
      actionId,
      actionStatus: 'pending',
    }),
  }
}


export function buildCopySupplierExpiryToCustomerActionPreview({
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
        ? resolveNamedTarget({request, services, scope: resolvedScope})
        : resolveContextTarget({services, scope: resolvedScope})

  if (resolution.status !== 'resolved') {
    if (resolution.status === 'ambiguous') {
      rememberPendingClarification({
        request,
        resolution,
        services,
        scope: resolvedScope,
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
        tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
        guard: `action-target-${resolution.status || 'unresolved'}`,
      }),
    }
  }

  const resolvedService = findResolvedService(services, resolution.item)

  if (resolvedService.status !== 'resolved') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply:
        resolvedService.status === 'grouped-row'
          ? 'La riga selezionata raggruppa più servizi. Indica il singolo servizio di cui vuoi allineare le scadenze.'
          : 'Il servizio selezionato non è più disponibile. Ripeti la ricerca prima di procedere.',
      data: {
        type: 'clarification',
        reason: `action-target-${resolvedService.status}`,
      },
      meta: buildActionMeta('clarification', {
        tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
        guard: `action-target-${resolvedService.status}`,
      }),
    }
  }

  const service = resolvedService.service
  const target = {
    type: 'service',
    id: String(service.id),
    label: getServiceLabel(service),
  }

  rememberRecentActionTarget(actorToken, target)

  const supplierResolution = resolveSubscriptionForRequest(service, {
    subscriptionType: 'supplier',
    subscriptionId: request.supplierSubscriptionId || null,
  })

  if (supplierResolution.status === 'empty') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: `Il servizio "${target.label}" non ha sottoscrizioni fornitore da cui copiare la scadenza.`,
      data: {type: 'clarification', reason: 'action-copy-supplier-subscription-not-found'},
      meta: buildActionMeta('clarification', {
        tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
        guard: 'action-copy-supplier-subscription-not-found',
      }),
    }
  }

  if (supplierResolution.status === 'not-found') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: `Non ho trovato la sottoscrizione fornitore indicata sul servizio "${target.label}".`,
      data: {type: 'clarification', reason: 'action-copy-supplier-subscription-id-not-found'},
      meta: buildActionMeta('clarification', {
        tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
        guard: 'action-copy-supplier-subscription-id-not-found',
      }),
    }
  }

  if (supplierResolution.status === 'ambiguous') {
    rememberPendingSubscriptionClarification({
      request: {...request, clarificationRole: 'supplier'},
      service,
      candidates: supplierResolution.candidates,
      scope: resolvedScope,
      actorToken,
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: [
        `Il servizio "${target.label}" ha più sottoscrizioni fornitore.`,
        'Da quale vuoi copiare la scadenza?',
        '',
        ...supplierResolution.candidates.map(buildSubscriptionChoiceLine),
        '',
        'Rispondi con il numero, l’ID, il piano, il fornitore oppure la scadenza.',
      ].join('\n'),
      data: {type: 'clarification', reason: 'action-copy-supplier-subscription-ambiguous'},
      meta: buildActionMeta('clarification', {
        tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
        guard: 'action-copy-supplier-subscription-ambiguous',
      }),
    }
  }

  const supplierSubscription = supplierResolution.subscription
  const supplierRef = buildSubscriptionReference(supplierSubscription)
  const supplierEndDate = supplierRef.endsOn

  if (!supplierEndDate) {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply:
        `La sottoscrizione fornitore selezionata per "${target.label}" non ha una scadenza ` +
        'da copiare.',
      data: {type: 'clarification', reason: 'action-copy-supplier-expiry-missing'},
      meta: buildActionMeta('clarification', {
        tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
        guard: 'action-copy-supplier-expiry-missing',
      }),
    }
  }

  const customerResolution = resolveSubscriptionForRequest(service, {
    subscriptionType: 'customer',
    subscriptionId: request.customerSubscriptionId || null,
  })

  if (customerResolution.status === 'empty') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: `Il servizio "${target.label}" non ha sottoscrizioni cliente su cui copiare la scadenza.`,
      data: {type: 'clarification', reason: 'action-copy-customer-subscription-not-found'},
      meta: buildActionMeta('clarification', {
        tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
        guard: 'action-copy-customer-subscription-not-found',
      }),
    }
  }

  if (customerResolution.status === 'not-found') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: `Non ho trovato la sottoscrizione cliente indicata sul servizio "${target.label}".`,
      data: {type: 'clarification', reason: 'action-copy-customer-subscription-id-not-found'},
      meta: buildActionMeta('clarification', {
        tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
        guard: 'action-copy-customer-subscription-id-not-found',
      }),
    }
  }

  if (customerResolution.status === 'ambiguous') {
    rememberPendingSubscriptionClarification({
      request: {
        ...request,
        clarificationRole: 'customer',
        supplierSubscriptionId: supplierRef.id,
      },
      service,
      candidates: customerResolution.candidates,
      scope: resolvedScope,
      actorToken,
    })

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: [
        `Il servizio "${target.label}" ha più sottoscrizioni cliente.`,
        `Su quale vuoi copiare la scadenza fornitore del ${formatInvoiceDate(supplierEndDate)}?`,
        '',
        ...customerResolution.candidates.map(buildSubscriptionChoiceLine),
        '',
        'Rispondi con il numero, l’ID, il piano oppure la scadenza attuale.',
      ].join('\n'),
      data: {type: 'clarification', reason: 'action-copy-customer-subscription-ambiguous'},
      meta: buildActionMeta('clarification', {
        tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
        guard: 'action-copy-customer-subscription-ambiguous',
      }),
    }
  }

  const customerSubscription = customerResolution.subscription
  const customerRef = buildSubscriptionReference(customerSubscription)
  const currentCustomerEndDate = customerRef.endsOn
  const customerStartsOn = customerRef.startsOn

  if (customerStartsOn && supplierEndDate.slice(0, 10) < customerStartsOn.slice(0, 10)) {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply:
        `La scadenza fornitore (${formatInvoiceDate(supplierEndDate)}) precede l’inizio della ` +
        `sottoscrizione cliente (${formatInvoiceDate(customerStartsOn)}). Non posso copiarla.`,
      data: {type: 'clarification', reason: 'action-copy-end-before-customer-start'},
      meta: buildActionMeta('clarification', {
        tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
        guard: 'action-copy-end-before-customer-start',
      }),
    }
  }

  if (currentCustomerEndDate === supplierEndDate) {
    return {
      ok: true,
      intent: 'action-result',
      source: 'tool-fast',
      reply:
        `La sottoscrizione cliente del servizio "${target.label}" ha già la stessa scadenza ` +
        `del fornitore: ${formatInvoiceDate(supplierEndDate)}.`,
      data: {
        type: 'action-result',
        action: {
          tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
          requiresConfirmation: false,
          target,
          subscription: customerRef,
          sourceSubscription: supplierRef,
          changes: [],
        },
        result: {status: 'noop', changed: false},
      },
      meta: buildActionMeta('action-result', {
        tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
        actionStatus: 'noop',
      }),
    }
  }

  const changes = [
    buildChange(
      'subscriptionEndDate',
      'SCADENZA CLIENTE',
      currentCustomerEndDate,
      supplierEndDate
    ),
  ]
  const now = Date.now()
  const actionId = randomUUID()
  const actorFingerprint = fingerprintToken(actorToken)

  supersedePendingProposals(actorFingerprint)

  const proposal = {
    actionId,
    tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
    operation: 'subscription-end-date',
    executionMode: 'copy-supplier-expiry-to-customer',
    status: 'pending',
    actorFingerprint,
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
    target,
    subscription: customerRef,
    sourceSubscription: supplierRef,
    changes,
    field: 'subscriptionEndDate',
    label: 'SCADENZA CLIENTE',
    requestedValue: supplierEndDate,
    expectedValues: {subscriptionEndDate: currentCustomerEndDate},
    desiredValues: {subscriptionEndDate: supplierEndDate},
    expectedSourceEndDate: supplierEndDate,
  }

  proposals.set(actionId, proposal)
  auditAction('proposed', proposal, {
    subscription: customerRef,
    sourceSubscription: supplierRef,
  })

  return {
    ok: true,
    intent: 'action-proposal',
    source: 'tool-fast',
    reply:
      `Sul servizio "${target.label}" copierò la scadenza della sottoscrizione fornitore ` +
      `(ID ${supplierRef.id}${supplierRef.planName ? `, piano ${supplierRef.planName}` : ''}) ` +
      `del ${formatInvoiceDate(supplierEndDate)} sulla sottoscrizione cliente ` +
      `(ID ${customerRef.id}${customerRef.planName ? `, piano ${customerRef.planName}` : ''}), ` +
      `che ora scade ${currentCustomerEndDate ? `il ${formatInvoiceDate(currentCustomerEndDate)}` : 'senza una data impostata'}. ` +
      'La modifica riguarda solo il CRM e non rinnova il servizio né aggiorna automaticamente Plesk o altri sistemi. Confermi?',
    data: {
      type: 'action-preview',
      action: {
        actionId,
        tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
        requiresConfirmation: true,
        expiresAt: new Date(proposal.expiresAt).toISOString(),
        target,
        subscription: customerRef,
        sourceSubscription: supplierRef,
        changes,
      },
    },
    meta: buildActionMeta('action-proposal', {
      tool: COPY_SUPPLIER_EXPIRY_TOOL_ID,
      actionId,
      actionStatus: 'pending',
    }),
  }
}


export function buildServicePleskPlanSyncActionPreview({
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
        ? resolveNamedTarget({request, services, scope: resolvedScope})
        : resolveContextTarget({services, scope: resolvedScope})

  if (resolution.status !== 'resolved') {
    if (resolution.status === 'ambiguous') {
      rememberPendingClarification({
        request,
        resolution,
        services,
        scope: resolvedScope,
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
        tool: PLESK_PLAN_SYNC_TOOL_ID,
        guard: `action-target-${resolution.status || 'unresolved'}`,
      }),
    }
  }

  const resolvedService = findResolvedService(services, resolution.item)

  if (resolvedService.status !== 'resolved') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply:
        resolvedService.status === 'grouped-row'
          ? 'La riga selezionata raggruppa più servizi. Indica il singolo servizio per cui vuoi modificare la sincronizzazione del piano con Plesk.'
          : 'Il servizio selezionato non è più disponibile. Ripeti la ricerca prima di procedere.',
      data: {
        type: 'clarification',
        reason: `action-target-${resolvedService.status}`,
      },
      meta: buildActionMeta('clarification', {
        tool: PLESK_PLAN_SYNC_TOOL_ID,
        guard: `action-target-${resolvedService.status}`,
      }),
    }
  }

  const service = resolvedService.service
  const target = {
    type: 'service',
    id: String(service.id),
    label: getServiceLabel(service),
  }

  rememberRecentActionTarget(actorToken, target)

  if (!hasPleskService(service)) {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: `Il servizio "${target.label}" non è collegato a Plesk. La sincronizzazione del piano può essere modificata solo per servizi gestiti da Plesk.`,
      data: {
        type: 'clarification',
        reason: 'action-plesk-plan-sync-not-linked',
      },
      meta: buildActionMeta('clarification', {
        tool: PLESK_PLAN_SYNC_TOOL_ID,
        guard: 'action-plesk-plan-sync-not-linked',
      }),
    }
  }

  const currentValue = getServicePleskPlanSyncValue(service)
  const desiredValue = request.desiredValue === true

  if (currentValue === desiredValue) {
    return {
      ok: true,
      intent: 'action-result',
      source: 'tool-fast',
      reply: desiredValue
        ? `La sincronizzazione del piano con Plesk è già attiva per il servizio "${target.label}".`
        : `La sincronizzazione del piano con Plesk è già disattivata per il servizio "${target.label}".`,
      data: {
        type: 'action-result',
        action: {
          tool: PLESK_PLAN_SYNC_TOOL_ID,
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
        tool: PLESK_PLAN_SYNC_TOOL_ID,
        actionStatus: 'noop',
      }),
    }
  }

  const changes = [
    buildChange(
      'pleskPlansSync',
      'SINCRONIZZAZIONE PIANO PLESK',
      currentValue,
      desiredValue
    ),
  ]
  const now = Date.now()
  const actionId = randomUUID()
  const actorFingerprint = fingerprintToken(actorToken)

  supersedePendingProposals(actorFingerprint)

  const proposal = {
    actionId,
    tool: PLESK_PLAN_SYNC_TOOL_ID,
    operation: 'plesk-plan-sync',
    status: 'pending',
    actorFingerprint,
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
    target,
    changes,
    field: 'pleskPlansSync',
    label: 'SINCRONIZZAZIONE PIANO PLESK',
    requestedValue: desiredValue,
    expectedValues: {
      pleskPlansSync: currentValue,
    },
    desiredValues: {
      pleskPlansSync: desiredValue,
    },
  }

  proposals.set(actionId, proposal)
  auditAction('proposed', proposal)

  const effect = desiredValue
    ? 'I futuri cambi piano potranno essere sincronizzati con Plesk. Il piano attuale non viene modificato da questa operazione.'
    : 'I futuri cambi piano effettuati nel CRM non verranno sincronizzati automaticamente con Plesk. Il piano attuale non viene modificato.'

  return {
    ok: true,
    intent: 'action-proposal',
    source: 'tool-fast',
    reply: `Sul servizio "${target.label}" ${describePlannedChanges(changes)}. ${effect} Confermi?`,
    data: {
      type: 'action-preview',
      action: {
        actionId,
        tool: PLESK_PLAN_SYNC_TOOL_ID,
        requiresConfirmation: true,
        expiresAt: new Date(proposal.expiresAt).toISOString(),
        target,
        changes,
        effects: {
          changesCurrentPlan: false,
          affectsFuturePlanChanges: true,
          synchronizesFuturePlanChanges: desiredValue,
        },
      },
    },
    meta: buildActionMeta('action-proposal', {
      tool: PLESK_PLAN_SYNC_TOOL_ID,
      actionId,
      actionStatus: 'pending',
    }),
  }
}


export function buildServiceAuthCodeActionPreview({
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
        ? resolveNamedTarget({request, services, scope: resolvedScope})
        : resolveContextTarget({services, scope: resolvedScope})

  if (resolution.status !== 'resolved') {
    if (resolution.status === 'ambiguous') {
      rememberPendingClarification({
        request,
        resolution,
        services,
        scope: resolvedScope,
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
        tool: AUTH_CODE_TOOL_ID,
        guard: `action-target-${resolution.status || 'unresolved'}`,
      }),
    }
  }

  const resolvedService = findResolvedService(services, resolution.item)

  if (resolvedService.status !== 'resolved') {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply:
        resolvedService.status === 'grouped-row'
          ? 'La riga selezionata raggruppa più servizi. Indica il singolo servizio per cui vuoi modificare l’AUTH CODE.'
          : 'Il servizio selezionato non è più disponibile. Ripeti la ricerca prima di procedere.',
      data: {
        type: 'clarification',
        reason: `action-target-${resolvedService.status}`,
      },
      meta: buildActionMeta('clarification', {
        tool: AUTH_CODE_TOOL_ID,
        guard: `action-target-${resolvedService.status}`,
      }),
    }
  }

  const service = resolvedService.service
  const target = {
    type: 'service',
    id: String(service.id),
    label: getServiceLabel(service),
  }

  rememberRecentActionTarget(actorToken, target)

  const currentAuthCode = normalizeAuthCodeValue(service?.authCode ?? service?.auth_code ?? null)
  const desiredAuthCode = request.clear
    ? null
    : normalizeAuthCodeValue(request.desiredAuthCode)

  if (!request.clear && !desiredAuthCode) {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply:
        'Indica il nuovo AUTH CODE. Per codici con spazi o punteggiatura è preferibile racchiuderlo tra virgolette.',
      data: {
        type: 'clarification',
        reason: 'action-auth-code-missing',
      },
      meta: buildActionMeta('clarification', {
        tool: AUTH_CODE_TOOL_ID,
        guard: 'action-auth-code-missing',
      }),
    }
  }

  if (desiredAuthCode && desiredAuthCode.length > AUTH_CODE_MAX_LENGTH) {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: `L’AUTH CODE supera la lunghezza massima consentita di ${AUTH_CODE_MAX_LENGTH} caratteri.`,
      data: {
        type: 'clarification',
        reason: 'action-auth-code-too-long',
      },
      meta: buildActionMeta('clarification', {
        tool: AUTH_CODE_TOOL_ID,
        guard: 'action-auth-code-too-long',
      }),
    }
  }

  if (sameActionValue('authCode', currentAuthCode, desiredAuthCode)) {
    return {
      ok: true,
      intent: 'action-result',
      source: 'tool-fast',
      reply: desiredAuthCode
        ? `Il servizio "${target.label}" ha già questo AUTH CODE impostato.`
        : `Il servizio "${target.label}" non ha un AUTH CODE impostato.`,
      data: {
        type: 'action-result',
        action: {
          tool: AUTH_CODE_TOOL_ID,
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
        tool: AUTH_CODE_TOOL_ID,
        actionStatus: 'noop',
      }),
    }
  }

  const changes = [buildAuthCodeChange(currentAuthCode, desiredAuthCode)]
  const now = Date.now()
  const actionId = randomUUID()
  const actorFingerprint = fingerprintToken(actorToken)

  supersedePendingProposals(actorFingerprint)

  const proposal = {
    actionId,
    tool: AUTH_CODE_TOOL_ID,
    operation: 'auth-code',
    status: 'pending',
    actorFingerprint,
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
    target,
    changes,
    field: 'authCode',
    label: 'AUTH CODE',
    requestedValue: authCodeState(desiredAuthCode),
    expectedValues: {
      authCode: currentAuthCode,
    },
    desiredValues: {
      authCode: desiredAuthCode,
    },
  }

  proposals.set(actionId, proposal)
  auditAction('proposed', proposal)

  return {
    ok: true,
    intent: 'action-proposal',
    source: 'tool-fast',
    reply:
      `Sul servizio "${target.label}" ${describePlannedChanges(changes)}. ` +
      'Il valore non verrà mostrato nelle risposte né inserito nell’audit dell’action. Confermi?',
    data: {
      type: 'action-preview',
      action: {
        actionId,
        tool: AUTH_CODE_TOOL_ID,
        requiresConfirmation: true,
        expiresAt: new Date(proposal.expiresAt).toISOString(),
        target,
        changes,
        effects: {
          sensitiveValue: true,
          valueExposedInResponse: false,
          valueIncludedInActionAudit: false,
        },
      },
    },
    meta: buildActionMeta('action-proposal', {
      tool: AUTH_CODE_TOOL_ID,
      actionId,
      actionStatus: 'pending',
    }),
  }
}

export function buildServiceTransferTargetActionPreview({
  request,
  services = [],
  providers = [],
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
        providers,
        scope: resolvedScope,
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
        tool: TRANSFER_TOOL_ID,
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
        'La riga selezionata raggruppa più servizi. Indica il nome esatto del singolo servizio da marcare come DA TRASFERIRE.',
      data: {
        type: 'clarification',
        reason: 'action-target-grouped-row',
        serviceIds: resolvedService.ids,
      },
      meta: buildActionMeta('clarification', {
        tool: TRANSFER_TOOL_ID,
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
        tool: TRANSFER_TOOL_ID,
        guard: 'action-target-not-found',
      }),
    }
  }

  const service = resolvedService.service
  const target = {
    type: 'service',
    id: String(service.id),
    label: getServiceLabel(service),
  }

  rememberRecentActionTarget(actorToken, target)

  const currentProvider = getServiceTransferProvider(service)
  let desiredProvider = null

  if (!request.clear) {
    const providerResolution = resolveTransferProvider(request.providerQuery, providers)

    if (providerResolution.status === 'ambiguous') {
      rememberPendingProviderClarification({
        request,
        providerResolution,
        scope: {
          ...resolvedScope,
          serviceId: service.id,
        },
        actorToken,
      })

      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: [
          `Ho trovato più fornitori corrispondenti a "${providerResolution.term || ''}".`,
          'Quale vuoi impostare come destinazione del trasferimento?',
          '',
          ...providerResolution.candidates.map(
            (provider, index) => `${index + 1}. ${providerLabel(provider)} (ID ${provider.id})`
          ),
        ].join('\n'),
        data: {
          type: 'clarification',
          reason: 'action-provider-ambiguous',
        },
        meta: buildActionMeta('clarification', {
          tool: TRANSFER_TOOL_ID,
          guard: 'action-provider-ambiguous',
        }),
      }
    }

    if (providerResolution.status !== 'resolved') {
      return {
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply:
          providerResolution.status === 'missing-provider'
            ? 'Indica anche il fornitore verso cui vuoi marcare il servizio come DA TRASFERIRE.'
            : `Non ho trovato il fornitore "${providerResolution.term || request.providerQuery || ''}". Indica il nome completo o l’ID.`,
        data: {
          type: 'clarification',
          reason: `action-provider-${providerResolution.status || 'unresolved'}`,
        },
        meta: buildActionMeta('clarification', {
          tool: TRANSFER_TOOL_ID,
          guard: `action-provider-${providerResolution.status || 'unresolved'}`,
        }),
      }
    }

    desiredProvider = providerResolution.provider
  }

  if (sameProvider(currentProvider, desiredProvider)) {
    return {
      ok: true,
      intent: 'action-result',
      source: 'tool-fast',
      reply: desiredProvider
        ? `Il servizio "${target.label}" è già marcato DA TRASFERIRE verso ${providerLabel(
            desiredProvider
          )}.`
        : `Il servizio "${target.label}" non è marcato DA TRASFERIRE.`,
      data: {
        type: 'action-result',
        action: {
          tool: TRANSFER_TOOL_ID,
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
        tool: TRANSFER_TOOL_ID,
        actionStatus: 'noop',
      }),
    }
  }

  const changes = [
    buildChange('toTransfer', 'DA TRASFERIRE', currentProvider, desiredProvider),
  ]

  const now = Date.now()
  const actionId = randomUUID()
  const actorFingerprint = fingerprintToken(actorToken)

  supersedePendingProposals(actorFingerprint)

  const proposal = {
    actionId,
    tool: TRANSFER_TOOL_ID,
    operation: 'transfer-target',
    status: 'pending',
    actorFingerprint,
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
    target,
    changes,
    field: 'toTransfer',
    label: 'DA TRASFERIRE',
    requestedValue: desiredProvider,
    expectedValues: {
      toTransfer: currentProvider?.id || null,
    },
    desiredValues: {
      toTransfer: desiredProvider?.id || null,
    },
  }

  proposals.set(actionId, proposal)
  auditAction('proposed', proposal)

  const operationDescription = desiredProvider
    ? `imposterò DA TRASFERIRE verso ${providerLabel(desiredProvider)}`
    : `rimuoverò DA TRASFERIRE${
        currentProvider ? ` verso ${providerLabel(currentProvider)}` : ''
      }`

  return {
    ok: true,
    intent: 'action-proposal',
    source: 'tool-fast',
    reply:
      `Sul servizio "${target.label}" ${operationDescription}. ` +
      'Questa marcatura non avvia il trasferimento e non modifica fornitore attuale, sottoscrizioni o auth code. Confermi?',
    data: {
      type: 'action-preview',
      action: {
        actionId,
        tool: TRANSFER_TOOL_ID,
        requiresConfirmation: true,
        expiresAt: new Date(proposal.expiresAt).toISOString(),
        target,
        changes,
        effects: {
          startsTransfer: false,
          changesCurrentSupplier: false,
          changesSubscriptions: false,
          changesAuthCode: false,
        },
      },
    },
    meta: buildActionMeta('action-proposal', {
      tool: TRANSFER_TOOL_ID,
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
            subscription: proposal.subscription || null,
            changes: proposal.changes,
          }
        : null,
      error: {
        code,
        details,
      },
    },
    meta: buildActionMeta('action-error', {
      tool: proposal?.tool || TOOL_ID,
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
          subscription: proposal.subscription || null,
          sourceSubscription: proposal.sourceSubscription || null,
          changes: proposal.changes,
        },
        decision: 'cancel',
        status: 'cancelled',
      },
      meta: buildActionMeta('action-confirmation', {
        tool: proposal.tool || TOOL_ID,
        actionId: proposal.actionId,
        actionStatus: 'cancelled',
      }),
    }
  }

  proposal.status = 'executing'
  auditAction('confirmed', proposal)

  try {
    const result =
      proposal.executionMode === 'copy-supplier-expiry-to-customer'
        ? await copySupplierExpiryToCustomer({
            serviceId: proposal.target.id,
            customerSubscriptionId: proposal.subscription?.id,
            supplierSubscriptionId: proposal.sourceSubscription?.id,
            expectedCustomerEndDate:
              (proposal.expectedValues || proposal.expectedFlags)?.subscriptionEndDate ?? null,
            expectedSupplierEndDate: proposal.expectedSourceEndDate ?? null,
            actionId: proposal.actionId,
          })
        : proposal.operation === 'subscription-end-date'
          ? await updateSubscriptionEndDate({
              serviceId: proposal.target.id,
              subscriptionId: proposal.subscription?.id,
              expectedEndDate:
                (proposal.expectedValues || proposal.expectedFlags)?.subscriptionEndDate ?? null,
              newEndDate:
                (proposal.desiredValues || proposal.desiredFlags)?.subscriptionEndDate ?? null,
              expectedIsSupplier: proposal.subscription?.type === 'supplier',
              actionId: proposal.actionId,
            })
          : await updateServiceFlags({
            serviceId: proposal.target.id,
            expected: proposal.expectedValues || proposal.expectedFlags,
            changes: proposal.desiredValues || proposal.desiredFlags,
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
          ? `Stato precedente ripristinato sul servizio "${proposal.target.label}": ${describeCompletedChanges(
              proposal.changes
            )}.`
          : `Operazione completata sul servizio "${proposal.target.label}": ${describeCompletedChanges(
              proposal.changes
            )}.`,
      data: {
        type: 'action-result',
        action: {
          actionId: proposal.actionId,
          tool: proposal.tool,
          target: proposal.target,
          subscription: proposal.subscription || null,
          sourceSubscription: proposal.sourceSubscription || null,
          changes: proposal.changes,
        },
        result: {
          status: 'completed',
          changed: result?.changed === true,
          service: result?.service || null,
          subscription: result?.subscription || null,
        },
      },
      meta: buildActionMeta('action-result', {
        tool: proposal.tool || TOOL_ID,
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
