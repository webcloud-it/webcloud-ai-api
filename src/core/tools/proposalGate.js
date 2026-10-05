import {createHash} from 'node:crypto'

// Only server-emitted previews enter this index. Domain stores retain targets,
// expected values and executors; client history never authorizes a mutation.
const proposals = new Map()
const latestBySession = new Map()
const RETENTION_MS = 30 * 60 * 1000

// readJson adapters currently retain the HTTP status in their error message.
export function isProposalAuthorizationError(error) {
  const status = Number(error?.statusCode || error?.status)
  const message = typeof error === 'string' ? error : String(error?.message || '')
  return [401, 403].includes(status) || message.includes('(401)') || message.includes('(403)')
}

function fingerprint(value) {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

function owner(principal) {
  return typeof principal?.id === 'string' && principal.id.trim() && principal.source
    ? {id: principal.id, source: principal.source, roleId: principal.roleId || null} : null
}

function cleanup() {
  for (const [id, entry] of proposals) {
    if (entry.expiresAt + RETENTION_MS <= Date.now()) {
      proposals.delete(id)
      if (latestBySession.get(entry.session) === id) latestBySession.delete(entry.session)
    }
  }
}

export function rememberBackendProposal({payload, auth, sessionToken, credentialKey} = {}) {
  if (!['action-preview', 'action-proposal', 'action-confirmation'].includes(payload?.data?.type)) return
  const data = payload.data
  const action = data.action || data
  if (action.requiresConfirmation !== true && data.confirmationRequired !== true) return
  const id = action.actionId || data.proposalToken
  const expiresAt = Date.parse(action.expiresAt || data.expiresAt)
  if (typeof id !== 'string' || !id || !Number.isFinite(expiresAt)) return
  cleanup()
  // A repeated presentation cannot rebind ownership or reactivate a consumed ID.
  if (proposals.has(id)) return
  const session = fingerprint(sessionToken)
  const previous = proposals.get(latestBySession.get(session))
  if (previous?.status === 'pending') previous.status = 'superseded'
  const tokenSource = credentialKey && auth.token === auth.credentials?.[credentialKey] ? credentialKey : 'token'
  const entry = {
    id, session, owner: owner(auth.principal), moduleId: payload.meta?.moduleId,
    tokenSource, credentialKey, actor: fingerprint(auth.token), expiresAt,
    status: 'pending',
    // Saved backend payload is used only by existing token-based decision handlers.
    payload: structuredClone(payload),
  }
  proposals.set(id, entry)
  latestBySession.set(session, id)
}

function failure(code, reply, entry = null) {
  return {ok: false, intent: 'action-error', source: 'proposal', reply,
    data: {type: 'action-error', error: {code}},
    meta: {moduleId: entry?.moduleId || 'facile', routingSource: 'proposal-decision',
      actionId: entry?.id || null, actionStatus: entry?.status || 'not-found', errorCode: code}}
}

function parseDecision(body = {}, parseLegacyDecision = null) {
  if (body.action != null) {
    const action = body.action
    if (!action || typeof action !== 'object' || Array.isArray(action)) return {invalid: true}
    if (['proposal-confirm', 'proposal-cancel'].includes(action.type)) {
      if (Object.keys(action).some(key => !['type', 'proposalId'].includes(key))) return {invalid: true}
      return {id: action.proposalId, decision: action.type === 'proposal-confirm' ? 'confirm' : 'cancel'}
    }
    if (Object.keys(action).some(key => !['actionId', 'decision'].includes(key))) return {invalid: true}
    return {id: action.actionId, decision: action.decision}
  }
  const text = typeof body.message === 'string' ? body.message.trim().toLocaleLowerCase('it') : ''
  // Stable UI protocol, not a general language parser.
  if (text === 'confermo') return {decision: 'confirm'}
  if (text === 'annulla') return {decision: 'cancel'}
  const legacyDecision = typeof parseLegacyDecision === 'function' ? parseLegacyDecision(body.message) : null
  if (['confirm', 'cancel'].includes(legacyDecision)) return {decision: legacyDecision}
  return null
}

export async function handleProposalDecision({body, auth, getModule} = {}) {
  cleanup()
  const session = fingerprint(auth?.token)
  const latestId = latestBySession.get(session)
  const latest = proposals.get(latestId)
  const action = parseDecision(body, latest ? getModule(latest.moduleId)?.routes?.parseProposalDecision : null)
  if (!action) return null
  const entry = proposals.get(action.id || latestId)
  let result
  if (action.invalid || !['confirm', 'cancel'].includes(action.decision) ||
      (body?.action != null && (typeof action.id !== 'string' || !action.id.trim()))) {
    result = failure('invalid-decision', 'Decisione non valida: specifica conferma o annullamento e l’identificatore della proposta.')
  } else if (!entry) {
    result = failure('action-not-found', 'Non c’è una proposta disponibile da confermare o annullare. Richiedi una nuova anteprima.')
  } else {
    const principal = owner(auth?.principal)
    const token = entry.tokenSource === 'token' ? auth?.token : auth?.credentials?.[entry.tokenSource]
    if (!principal || !entry.owner) {
      result = failure('action-principal-required', 'È richiesta una sessione autenticata per decidere questa proposta.', entry)
    } else if (principal.id !== entry.owner.id || principal.source !== entry.owner.source ||
        principal.roleId !== entry.owner.roleId || entry.session !== session ||
        fingerprint(token) !== entry.actor || !auth?.credentials?.[entry.credentialKey]) {
      result = failure('action-owner-mismatch', 'Questa proposta non appartiene al principal e alla sessione autorizzati.', entry)
    } else if (entry.id !== latestId || entry.status === 'superseded') {
      result = failure('action-superseded', 'Questa proposta è stata sostituita da una più recente. Usa la nuova anteprima.', entry)
    } else if (entry.status !== 'pending') {
      result = failure('action-already-finalized', 'Questa proposta è già stata confermata, annullata o conclusa.', entry)
    } else if (entry.expiresAt <= Date.now()) {
      entry.status = 'expired'
      result = failure('action-expired', 'La proposta è scaduta. Richiedi una nuova anteprima.', entry)
    } else {
      const module = getModule(entry.moduleId)
      if (typeof module?.routes?.decideProposal !== 'function') {
        result = failure('action-handler-unavailable', 'Il handler della proposta non è disponibile. Nessuna operazione è stata eseguita.', entry)
      } else {
        // Claim synchronously, before the first await: also blocks concurrent replay.
        entry.status = 'executing'
        try {
          result = await module.routes.decideProposal({
            action: {actionId: entry.id, decision: action.decision}, actorToken: token,
            principal, proposal: entry.payload,
          })
          if (!result) result = failure('action-not-found', 'La proposta applicativa non è più disponibile. Richiedi una nuova anteprima.', entry)
          entry.status = result.data?.type === 'action-error' ? 'failed' : action.decision === 'cancel' ? 'cancelled' : 'completed'
          if (result.data?.type === 'action-error') result = {...result, ok: false}
          if (result.data?.type === 'action-error' && !String(result.data.error?.code).includes('partial') &&
              isProposalAuthorizationError(result.data.error?.details?.message)) {
            result = failure('action-authorization-denied', 'L’adapter ha rifiutato l’autorizzazione. Nessuna nuova esecuzione verrà tentata con questa proposta.', entry)
          }
          if (result.meta?.verificationStatus === 'verification-failed') {
            result = {...result, ok: false, meta: {...result.meta, errorCode: 'post-operation-verification-failed'}}
          }
        } catch (error) {
          entry.status = 'failed'
          result = isProposalAuthorizationError(error)
            ? failure('action-authorization-denied', 'L’adapter ha rifiutato l’autorizzazione. Nessuna nuova esecuzione verrà tentata con questa proposta.', entry)
            : failure('execution-failed', 'Non è stato possibile completare l’operazione. La proposta non verrà rieseguita; verifica lo stato applicativo prima di riprovare.', entry)
        }
      }
    }
  }
  result.meta = {...result.meta, routingSource: 'proposal-decision',
    moduleId: entry?.moduleId || result.meta?.moduleId || 'facile',
    actionId: entry?.id || null, actionStatus: entry?.status || 'not-found',
    errorCode: result.meta?.errorCode || result.data?.error?.code || null}
  console.info('[ai-proposal]', JSON.stringify({actionId: result.meta.actionId,
    moduleId: result.meta.moduleId, decision: action.decision || null,
    status: result.meta.actionStatus, errorCode: result.meta.errorCode}))
  return result
}
