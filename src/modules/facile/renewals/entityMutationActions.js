import {createHash, randomUUID} from 'node:crypto'

import {getEntityMutationDefinition} from './entityMutationRegistry.js'
import {
  buildReadQueryTargetClarification,
  resolveReadQueryDetailTarget,
} from './readQueryTargetResolver.js'

const PROPOSAL_TTL_MS = 10 * 60 * 1000
const COMPLETED_TTL_MS = 30 * 60 * 1000
const proposals = new Map()
const completedMutations = new Map()

const CONFIRM_PATTERNS = [
  /^(?:si|sì|confermo|conferma|ok|okay|va bene|procedi|procedi pure|vai|vai pure|fallo|esegui|applica|salva)$/i,
  /^(?:si|sì)[,\s]+(?:confermo|procedi|vai|fallo|esegui|applica|ok)$/i,
]

const CANCEL_PATTERNS = [
  /^(?:no|annulla|annullo|cancella|stop|ferma|lascia stare|lascia perdere|non procedere|non farlo)$/i,
]

const EXPLICIT_UNDO_PATTERNS = [
  /^(?:annulla|ripristina|revoca)\s+(?:l['’]?ultima|la precedente)\s+modifica\s+(?:anagrafica|del catalogo)$/i,
  /^(?:annulla|ripristina|revoca)\s+l['’]?ultima\s+modifica\s+(?:del|della|dell['’])\s+.+$/i,
]

function fingerprintToken(token = '') {
  return createHash('sha256')
    .update(String(token || ''))
    .digest('hex')
    .slice(0, 24)
}

function cleanup(now = Date.now()) {
  for (const [key, proposal] of proposals.entries()) {
    if (!proposal || proposal.expiresAt <= now) proposals.delete(key)
  }

  for (const [key, completed] of completedMutations.entries()) {
    if (!completed || completed.expiresAt <= now) completedMutations.delete(key)
  }
}

function normalizeDecisionMessage(message = '') {
  return String(message || '')
    .trim()
    .replace(/[.!?]+$/g, '')
}

function parseDecision(message = '') {
  const text = normalizeDecisionMessage(message)
  if (!text) return null
  if (CONFIRM_PATTERNS.some(pattern => pattern.test(text))) return 'confirm'
  if (CANCEL_PATTERNS.some(pattern => pattern.test(text))) return 'cancel'
  return null
}

function cleanRawValue(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (/^(?:nessuno|nessuna|niente|null|vuoto|vuota|rimuovi|togli|azzera)$/i.test(text)) {
    return null
  }
  return text
}

function parseItalianNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value === null || value === undefined) return null

  let text = String(value)
    .trim()
    .replace(/\s+/g, '')
    .replace(/€/g, '')
    .replace(/(?:euro|mesi|mese)$/i, '')

  if (/^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(text)) {
    text = text.replace(/\./g, '').replace(',', '.')
  } else if (/^-?\d+(?:,\d+)?$/.test(text)) {
    text = text.replace(',', '.')
  }

  const number = Number(text)
  return Number.isFinite(number) ? number : null
}

function normalizeScalarValue(fieldDefinition, rawValue) {
  const value = cleanRawValue(rawValue)
  if (value === null) return null

  if (fieldDefinition.type === 'integer') {
    const number = parseItalianNumber(value)
    return Number.isInteger(number) ? number : null
  }

  if (fieldDefinition.type === 'number') {
    return parseItalianNumber(value)
  }

  return String(value).trim()
}

function getResolutionTargetId(resolution = {}) {
  if (resolution?.targetId) return String(resolution.targetId)
  if (resolution?.filter?.field === 'id' && resolution.filter.value) {
    return String(resolution.filter.value)
  }
  if (resolution?.item?.id) return String(resolution.item.id)
  return null
}

async function resolveNamedEntity({
  target,
  entityId,
  services,
  options,
  queryCatalog,
} = {}) {
  return resolveReadQueryDetailTarget({
    message: `dettagli di ${target}`,
    services,
    options,
    queryCatalog,
    readUtterance: {
      operation: 'detail',
      target,
      entityHint: entityId,
      source: 'entity-mutation',
    },
    requireUniqueRecord: true,
  })
}

function buildResolutionClarification(resolution, contextLabel = '') {
  if (resolution?.status === 'ambiguous' || resolution?.status === 'not-found') {
    const base = buildReadQueryTargetClarification(resolution)
    return contextLabel ? `${contextLabel}\n\n${base}` : base
  }

  return contextLabel || 'Non sono riuscito a identificare un solo elemento da modificare.'
}

async function resolveMutationChanges({
  plan,
  definition,
  services,
  options,
  queryCatalog,
} = {}) {
  const changes = []

  for (const requested of plan.changes || []) {
    const fieldDefinition = definition.fields.get(requested.field)
    if (!fieldDefinition) continue

    if (fieldDefinition.type !== 'relation') {
      const value = normalizeScalarValue(fieldDefinition, requested.value)

      if (
        value === null &&
        requested.value !== null &&
        requested.value !== undefined &&
        fieldDefinition.nullable !== true
      ) {
        return {
          status: 'invalid-value',
          reply: `Il valore indicato per ${fieldDefinition.label} non è valido.`,
        }
      }

      if (
        ['number', 'integer'].includes(fieldDefinition.type) &&
        requested.value !== null &&
        requested.value !== undefined &&
        value === null
      ) {
        return {
          status: 'invalid-value',
          reply: `Indica un valore numerico valido per ${fieldDefinition.label}.`,
        }
      }

      changes.push({
        field: requested.field,
        value,
        displayValue: value,
        label: fieldDefinition.label,
      })
      continue
    }

    const rawValue = cleanRawValue(requested.value)

    if (rawValue === null) {
      if (!fieldDefinition.nullable) {
        return {
          status: 'invalid-value',
          reply: `${fieldDefinition.label} non può essere rimosso.`,
        }
      }

      changes.push({
        field: requested.field,
        value: null,
        displayValue: null,
        label: fieldDefinition.label,
      })
      continue
    }

    const relationResolution = await resolveNamedEntity({
      target: rawValue,
      entityId: fieldDefinition.relationEntity,
      services,
      options,
      queryCatalog,
    })

    if (relationResolution.status !== 'resolved') {
      return {
        status: relationResolution.status,
        reply: buildResolutionClarification(
          relationResolution,
          `Non ho identificato con certezza il valore da assegnare al campo ${fieldDefinition.label}.`
        ),
        resolution: relationResolution,
      }
    }

    const relationId = getResolutionTargetId(relationResolution)
    if (!relationId) {
      return {
        status: 'ambiguous',
        reply: `Il valore indicato per ${fieldDefinition.label} non identifica un record univoco.`,
      }
    }

    changes.push({
      field: requested.field,
      value: relationId,
      displayValue: relationResolution.name || rawValue,
      label: fieldDefinition.label,
    })
  }

  return {status: 'resolved', changes}
}

function formatValue(value, displayValue = undefined) {
  const effective = displayValue !== undefined ? displayValue : value
  if (effective === null || effective === undefined || effective === '') return 'nessun valore'
  if (typeof effective === 'number') {
    return new Intl.NumberFormat('it-IT', {maximumFractionDigits: 2}).format(effective)
  }
  return String(effective)
}

function buildProposalReply({preview, displayChanges = [], undo = false} = {}) {
  const target = preview?.target || {}
  const title = undo
    ? `Anteprima ripristino del ${target.entitySingular || 'record'} ${target.name}:`
    : `Anteprima modifica del ${target.entitySingular || 'record'} ${target.name}:`

  const rows = (preview?.changes || []).map(change => {
    const display = displayChanges.find(item => item.field === change.field)
    return `- ${change.label}: ${formatValue(change.from)} → ${formatValue(change.to, display?.displayValue)}`
  })

  return [
    title,
    '',
    ...rows,
    '',
    'Confermi la modifica?',
  ].join('\n')
}

function rememberProposal(actorToken, proposal) {
  cleanup()
  proposals.set(fingerprintToken(actorToken), proposal)
}

function getProposal(actorToken) {
  cleanup()
  return proposals.get(fingerprintToken(actorToken)) || null
}

function removeProposal(actorToken) {
  proposals.delete(fingerprintToken(actorToken))
}

export function getRecentCompletedEntityMutationContext({actorToken = ''} = {}) {
  cleanup()
  const completed = completedMutations.get(fingerprintToken(actorToken))

  if (!completed) return null

  return {
    actionId: completed.actionId || null,
    entity: completed.entity || null,
    targetId: completed.targetId || null,
    target: completed.target ? {...completed.target} : null,
    completedAt: Number(completed.completedAt || 0),
    undo: completed.undo === true,
  }
}

export function hasPendingEntityMutationProposal({actorToken = ''} = {}) {
  return Boolean(getProposal(actorToken))
}

export async function buildEntityMutationProposal({
  plan,
  services = [],
  options = {},
  actorToken = '',
  queryCatalog,
  previewFn,
} = {}) {
  const definition = getEntityMutationDefinition(plan?.entity)

  if (!definition) {
    return {
      ok: true,
      intent: 'clarification',
      reply: 'Questa entità non è modificabile tramite il catalogo.',
      data: {type: 'clarification', reason: 'entity-mutation-unsupported-entity'},
    }
  }

  const targetResolution = await resolveNamedEntity({
    target: plan.target,
    entityId: definition.id,
    services,
    options,
    queryCatalog,
  })

  if (targetResolution.status !== 'resolved') {
    return {
      ok: true,
      intent: 'clarification',
      reply: buildResolutionClarification(targetResolution),
      data: {
        type: 'clarification',
        reason: `entity-mutation-target-${targetResolution.status}`,
        target: plan.target,
        candidates: targetResolution.candidates || [],
      },
    }
  }

  const targetId = getResolutionTargetId(targetResolution)
  if (!targetId) {
    return {
      ok: true,
      intent: 'clarification',
      reply: 'Il nome indicato corrisponde a più record. Specifica un elemento univoco.',
      data: {type: 'clarification', reason: 'entity-mutation-target-not-unique'},
    }
  }

  const resolvedChanges = await resolveMutationChanges({
    plan,
    definition,
    services,
    options,
    queryCatalog,
  })

  if (resolvedChanges.status !== 'resolved') {
    return {
      ok: true,
      intent: 'clarification',
      reply: resolvedChanges.reply,
      data: {
        type: 'clarification',
        reason: `entity-mutation-value-${resolvedChanges.status}`,
      },
    }
  }

  const preview = await previewFn({
    entity: definition.id,
    targetId,
    changes: resolvedChanges.changes.map(change => ({
      field: change.field,
      value: change.value,
    })),
  })

  if (preview?.status === 'no-change' || !preview?.changes?.length) {
    return {
      ok: true,
      intent: 'action-result',
      source: 'tool-fast',
      reply: `Il ${definition.singular} ${targetResolution.name || plan.target} ha già i valori richiesti.`,
      data: {
        type: 'action-result',
        status: 'no-change',
        result: preview,
      },
    }
  }

  const actionId = randomUUID()
  const proposal = {
    actionId,
    entity: definition.id,
    targetId,
    target: preview.target,
    expected: preview.expected,
    changes: resolvedChanges.changes,
    preview,
    undo: false,
    createdAt: Date.now(),
    expiresAt: Date.now() + PROPOSAL_TTL_MS,
  }

  rememberProposal(actorToken, proposal)

  return {
    ok: true,
    intent: 'action-proposal',
    source: plan.source === 'semantic' ? 'tool-semantic' : 'tool-fast',
    reply: buildProposalReply({preview, displayChanges: resolvedChanges.changes}),
    data: {
      type: 'action-preview',
      action: {
        actionId,
        operation: 'update-entity',
        target: preview.target,
        changes: preview.changes,
        requiresConfirmation: true,
        reversible: preview.reversible !== false,
      },
      preview,
    },
    meta: {
      moduleId: 'facile.renewals',
      entityMutation: true,
      plannerSource: plan.source,
    },
  }
}

export async function handlePendingEntityMutationDecisionMessage({
  message = '',
  actorToken = '',
  commitFn,
} = {}) {
  const proposal = getProposal(actorToken)
  if (!proposal) return null

  const decision = parseDecision(message)
  if (!decision) return null

  if (decision === 'cancel') {
    removeProposal(actorToken)
    return {
      ok: true,
      intent: 'action-confirmation',
      source: 'tool-fast',
      reply: 'Modifica annullata. Nessun dato è stato aggiornato.',
      data: {
        type: 'action-confirmation',
        decision: 'cancel',
        status: 'cancelled',
        actionId: proposal.actionId,
      },
    }
  }

  try {
    const result = await commitFn({
      entity: proposal.entity,
      targetId: proposal.targetId,
      expected: proposal.expected,
      changes: proposal.changes.map(change => ({
        field: change.field,
        value: change.value,
      })),
      actionId: proposal.actionId,
    })

    removeProposal(actorToken)
    completedMutations.set(fingerprintToken(actorToken), {
      ...proposal,
      result,
      completedAt: Date.now(),
      expiresAt: Date.now() + COMPLETED_TTL_MS,
    })

    const rows = (result?.changes || []).map(change =>
      `- ${change.label}: ${formatValue(change.from)} → ${formatValue(change.to)}`
    )

    return {
      ok: true,
      intent: 'action-result',
      source: 'tool-fast',
      reply: [
        `Modifica completata per ${result?.target?.entitySingular || 'record'} ${result?.target?.name || proposal.target?.name}.`,
        ...rows,
      ].join('\n'),
      data: {
        type: 'action-result',
        status: 'completed',
        result,
      },
    }
  } catch (error) {
    removeProposal(actorToken)

    return {
      ok: true,
      intent: 'action-error',
      source: 'tool-fast',
      reply: /stale|cambiati dopo l’anteprima/i.test(String(error?.message || ''))
        ? 'I dati sono cambiati dopo l’anteprima. La modifica non è stata applicata: ripeti la richiesta per creare una nuova anteprima.'
        : `Non è stato possibile applicare la modifica: ${error?.message || 'errore sconosciuto'}`,
      data: {
        type: 'action-error',
        error: {
          code: /stale|cambiati dopo l’anteprima/i.test(String(error?.message || ''))
            ? 'entity-mutation-stale-state'
            : 'entity-mutation-failed',
          message: error?.message || 'Errore modifica entità',
        },
      },
    }
  }
}

export function isRecentEntityMutationUndoRequest(message = '') {
  const text = normalizeDecisionMessage(message)
  return EXPLICIT_UNDO_PATTERNS.some(pattern => pattern.test(text))
}

export async function buildRecentEntityMutationUndoProposal({
  actorToken = '',
  previewFn,
} = {}) {
  cleanup()
  const completed = completedMutations.get(fingerprintToken(actorToken))

  if (!completed) {
    return {
      ok: true,
      intent: 'action-error',
      reply: 'Non ho una modifica anagrafica recente da annullare.',
      data: {type: 'action-error', error: {code: 'entity-mutation-undo-missing'}},
    }
  }

  const inverseChanges = (completed.preview?.changes || []).map(change => ({
    field: change.field,
    value: change.from,
    displayValue: change.from,
    label: change.label,
  }))

  const preview = await previewFn({
    entity: completed.entity,
    targetId: completed.targetId,
    changes: inverseChanges.map(change => ({field: change.field, value: change.value})),
  })

  if (!preview?.changes?.length) {
    return {
      ok: true,
      intent: 'action-result',
      reply: 'I valori precedenti risultano già ripristinati.',
      data: {type: 'action-result', status: 'no-change'},
    }
  }

  const actionId = randomUUID()
  rememberProposal(actorToken, {
    actionId,
    entity: completed.entity,
    targetId: completed.targetId,
    target: preview.target,
    expected: preview.expected,
    changes: inverseChanges,
    preview,
    undo: true,
    createdAt: Date.now(),
    expiresAt: Date.now() + PROPOSAL_TTL_MS,
  })

  return {
    ok: true,
    intent: 'action-proposal',
    source: 'tool-fast',
    reply: buildProposalReply({preview, displayChanges: inverseChanges, undo: true}),
    data: {
      type: 'action-preview',
      action: {
        actionId,
        operation: 'undo-entity-update',
        target: preview.target,
        changes: preview.changes,
        requiresConfirmation: true,
        reversible: true,
      },
      preview,
    },
  }
}
