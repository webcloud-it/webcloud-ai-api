import {createHash, randomUUID} from 'node:crypto'
import {getWebcamPresets, gotoWebcamPreset, inspectWebcamConnectivity, inspectWebcamDevice, rebootWebcam} from './service.js'

const proposals = new Map()
const PROPOSAL_TTL_MS = 10 * 60 * 1000

function fingerprintToken(token = '') {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 16)
}

function auditAction(event, proposal, extra = {}) {
  console.info('[webcam-action-audit]', JSON.stringify({
    at: new Date().toISOString(),
    event,
    actor: proposal?.actorFingerprint || null,
    operation: proposal?.operation || null,
    target: proposal ? {id: proposal.webcamId, name: proposal.name} : null,
    preset: proposal?.presetName || null,
    ...extra,
  }))
}

function isConfirmation(message) {
  return /^\s*(confermo|conferma|procedi|esegui|s[iì])\s*[.!]?\s*$/i.test(String(message || ''))
}

function isCancellation(message) {
  return /^\s*(annulla|cancella|no)\s*[.!]?\s*$/i.test(String(message || ''))
}

function findProposalToken(history = []) {
  return [...history].reverse().find(item => item?.data?.type === 'action-proposal' && ['webcam-reboot', 'webcam-goto-preset'].includes(item?.data?.operation))?.data?.proposalToken || null
}

function extractPresetMoveRequest(message = '') {
  const text = String(message).replace(/[?.!]+$/g, '').trim()
  let match = text.match(/\b(?:vai|richiama|raggiungi)\s+(?:al\s+)?preset\s+["“”']?(.+?)["“”']?\s+(?:sulla|della|per la)\s+webcam\s+["“”']?(.+?)["“”']?$/i)
  if (match) return {preset: match[1].trim(), target: match[2].trim()}
  match = text.match(/\b(?:porta|sposta|posiziona)\s+(?:la\s+)?webcam\s+["“”']?(.+?)["“”']?\s+(?:al|sul)\s+preset\s+["“”']?(.+?)["“”']?$/i)
  if (match) return {target: match[1].trim(), preset: match[2].trim()}
  return null
}

function extractRebootTarget(message = '') {
  const quoted = String(message).match(/["“”']([^"“”']{2,})["“”']/)?.[1]
  if (quoted) return quoted.trim()
  return String(message).match(/\b(?:riavvia|reboot)\s+(?:la\s+)?(?:webcam\s+)?(.+?)[?.!]*$/i)?.[1]?.trim() || null
}

function extractDiagnosticTarget(message = '') {
  const quoted = String(message).match(/["“”']([^"“”']{2,})["“”']/)?.[1]
  if (quoted) return quoted.trim()
  return String(message)
    .replace(/\b(?:fammi|mostrami|esegui|controlla|verifica)?\s*(?:la|le|il|i)?\s*(?:diagnostica|informazioni|info|versione|firmware|seriale|onvif|dispositivo|device)\b/gi, ' ')
    .replace(/\b(?:della|del|di|su|per|webcam)\b/gi, ' ')
    .replace(/[?.!]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveTarget(webcams = [], target = '') {
  const normalized = String(target).trim().toLowerCase()
  const exact = webcams.filter(item => [item.id, item.slug, item.name].some(value => String(value || '').toLowerCase() === normalized))
  if (exact.length === 1) return {status: 'resolved', item: exact[0]}
  const partial = webcams.filter(item => [item.slug, item.name, item.location].some(value => String(value || '').toLowerCase().includes(normalized)))
  if (partial.length === 1) return {status: 'resolved', item: partial[0]}
  return {status: partial.length > 1 ? 'ambiguous' : 'not-found', items: partial.slice(0, 8)}
}

export async function handleWebcamgoOperation({message, history = [], webcams = [], token, executeReboot = rebootWebcam, executeInspect = inspectWebcamDevice, executeConnectivity = inspectWebcamConnectivity, executePresets = getWebcamPresets, executeGotoPreset = gotoWebcamPreset} = {}) {
  const proposalToken = findProposalToken(history)

  if (proposalToken && (isConfirmation(message) || isCancellation(message))) {
    const proposal = proposals.get(proposalToken)
    if (!proposal || proposal.expiresAt < Date.now()) {
      if (proposal) auditAction('expired', proposal)
      proposals.delete(proposalToken)
      return response('expired', 'La proposta di riavvio è scaduta. Chiedimi nuovamente di prepararla.', {type: 'action-expired'})
    }
    if (proposal.actorFingerprint !== fingerprintToken(token)) {
      auditAction('rejected-actor', proposal)
      return response('action-error', 'Questa proposta appartiene a un’altra sessione e non può essere eseguita.', {type: 'action-error', operation: proposal.operation, error: {code: 'action-owner-mismatch'}})
    }
    if (isCancellation(message)) {
      proposals.delete(proposalToken)
      auditAction('cancelled', proposal)
      const label = proposal.operation === 'webcam-goto-preset'
        ? `il movimento di ${proposal.name} verso il preset ${proposal.presetName}`
        : `il riavvio di ${proposal.name}`
      return response('cancelled', `Ho annullato ${label}.`, {type: 'action-cancelled', operation: proposal.operation})
    }

    let result
    try {
      auditAction('confirmed', proposal)
      result = proposal.operation === 'webcam-goto-preset'
        ? await executeGotoPreset({token, webcamId: proposal.webcamId, presetToken: proposal.presetToken})
        : await executeReboot({token, webcamId: proposal.webcamId})
      auditAction('completed', proposal)
    } catch (error) {
      auditAction('failed', proposal, {errorName: error?.name || 'Error', status: Number(error?.statusCode || error?.status) || null})
      throw error
    } finally {
      proposals.delete(proposalToken)
    }
    if (proposal.operation === 'webcam-goto-preset') {
      return response('webcam-goto-preset-executed', `${proposal.name} è stata spostata verso il preset ${proposal.presetName}.`, {
        type: 'action-result', operation: proposal.operation, target: {id: proposal.webcamId, name: proposal.name}, preset: {name: proposal.presetName}, result,
      })
    }
    return response('webcam-reboot-executed', `Comando di riavvio inviato a ${proposal.name}.`, {
      type: 'action-result', operation: proposal.operation, target: {id: proposal.webcamId, name: proposal.name}, result,
    })
  }

  const presetMove = extractPresetMoveRequest(message)
  if (presetMove) {
    const resolved = resolveTarget(webcams, presetMove.target)
    if (resolved.status !== 'resolved') return response('clarification', `Non riesco a identificare una sola webcam per “${presetMove.target}”. Indica nome o slug esatto.`, {type: 'clarification', reason: `webcam-${resolved.status}`})
    let presetResult
    try {
      presetResult = await executePresets({token, webcamId: resolved.item.id})
    } catch (error) {
      if (/PTZ is not supported|PTZ non (?:è|e) supportato/i.test(String(error?.message || ''))) {
        return response('webcam-presets-unsupported', `${resolved.item.name} non supporta i controlli PTZ, quindi non può essere spostata verso un preset.`, {type: 'webcam-presets-unsupported', target: {id: resolved.item.id, name: resolved.item.name}})
      }
      throw error
    }
    const wanted = presetMove.preset.toLowerCase()
    const presets = presetResult.presets || []
    const exact = presets.filter(item => String(item.token).toLowerCase() === wanted || String(item.name || '').toLowerCase() === wanted)
    const partial = exact.length ? exact : presets.filter(item => String(item.name || '').toLowerCase().includes(wanted))
    if (partial.length !== 1) {
      const available = presets.slice(0, 10).map(item => item.name || `Preset ${item.token}`).join(', ')
      const reason = partial.length > 1 ? 'ambiguo' : 'non trovato'
      return response('clarification', `Il preset “${presetMove.preset}” è ${reason} per ${resolved.item.name}.${available ? ` Disponibili: ${available}.` : ''}`, {type: 'clarification', reason: `preset-${partial.length > 1 ? 'ambiguous' : 'not-found'}`})
    }
    const preset = partial[0]
    const opaqueToken = randomUUID()
    const proposal = {operation: 'webcam-goto-preset', webcamId: resolved.item.id, name: resolved.item.name, presetToken: String(preset.token), presetName: preset.name || `Preset ${preset.token}`, actorFingerprint: fingerprintToken(token), expiresAt: Date.now() + PROPOSAL_TTL_MS}
    proposals.set(opaqueToken, proposal)
    auditAction('proposed', proposal)
    return response('webcam-goto-preset-preview', `Sto per spostare ${proposal.name} verso il preset ${proposal.presetName}. Scrivi “confermo” per procedere oppure “annulla”.`, {
      type: 'action-proposal', operation: proposal.operation, proposalToken: opaqueToken, expiresAt: new Date(proposal.expiresAt).toISOString(), target: {id: proposal.webcamId, name: proposal.name}, preset: {name: proposal.presetName}, confirmationRequired: true,
    })
  }

  if (/\b(test|verifica|controlla)\s+(?:la\s+)?(?:connettivit[aà]|raggiungibilit[aà])/i.test(String(message || ''))) {
    const target = String(message)
      .replace(/connettivit[aà]|raggiungibilit[aà]/gi, ' ')
      .replace(/\b(?:test|verifica|controlla|la|della|del|di|su|per|webcam)\b/gi, ' ')
      .replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim()
    if (!target) return response('clarification', 'Di quale webcam vuoi verificare la connettività live?', {type: 'clarification', reason: 'missing-webcam-target'})
    const resolved = resolveTarget(webcams, target)
    if (resolved.status !== 'resolved') return response('clarification', `Non riesco a identificare una sola webcam per “${target}”. Indica nome o slug esatto.`, {type: 'clarification', reason: `webcam-${resolved.status}`})
    const result = await executeConnectivity({token, webcamId: resolved.item.id})
    return response('webcam-connectivity-live', `${resolved.item.name} ${result.reachable ? 'è raggiungibile' : 'non risponde'} sulla porta ${result.port}.`, {type: 'webcam-connectivity-live', item: result})
  }

  if (/\b(mostra|apri|visualizza|fammi vedere)\b[\s\S]*\b(snapshot|fotogramma|immagine)\b/i.test(String(message || ''))) {
    const target = String(message)
      .replace(/\b(?:mostra|apri|visualizza|fammi|vedere|lo|la|il|uno|una|snapshot|fotogramma|immagine|corrente|della|del|di|su|per|webcam)\b/gi, ' ')
      .replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim()
    if (!target) return response('clarification', 'Di quale webcam vuoi aprire lo snapshot?', {type: 'clarification', reason: 'missing-webcam-target'})
    const resolved = resolveTarget(webcams, target)
    if (resolved.status !== 'resolved') return response('clarification', `Non riesco a identificare una sola webcam per “${target}”. Indica nome o slug esatto.`, {type: 'clarification', reason: `webcam-${resolved.status}`})
    if (!resolved.item.slug) return response('webcam-snapshot-unavailable', `${resolved.item.name} non ha uno slug utilizzabile per lo snapshot.`, {type: 'webcam-snapshot-unavailable'})
    const url = `https://snapshot.webcamgo.com/${encodeURIComponent(resolved.item.slug)}.jpg?cb=${Date.now()}`
    return response('webcam-snapshot', `Snapshot corrente di ${resolved.item.name}.`, {
      type: 'webcam-snapshot',
      target: {id: resolved.item.id, name: resolved.item.name, slug: resolved.item.slug},
      actions: [{id: 'open-url', label: 'Apri snapshot', url}],
    })
  }

  if (/\b(elenca|mostra|quali|leggi)\b[\s\S]*\bpreset\b/i.test(String(message || ''))) {
    const target = String(message)
      .replace(/\b(?:elenca|mostra|quali|leggi|sono|i|gli|le|preset|disponibili|della|del|di|su|per|webcam)\b/gi, ' ')
      .replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim()
    if (!target) return response('clarification', 'Di quale webcam vuoi leggere i preset?', {type: 'clarification', reason: 'missing-webcam-target'})
    const resolved = resolveTarget(webcams, target)
    if (resolved.status !== 'resolved') return response('clarification', `Non riesco a identificare una sola webcam per “${target}”. Indica nome o slug esatto.`, {type: 'clarification', reason: `webcam-${resolved.status}`})
    let result
    try {
      result = await executePresets({token, webcamId: resolved.item.id})
    } catch (error) {
      const details = String(error?.message || '')
      if (/PTZ is not supported|PTZ non (?:è|e) supportato/i.test(details)) {
        return response('webcam-presets-unsupported', `${resolved.item.name} non supporta i controlli PTZ, quindi non dispone di preset richiamabili.`, {
          type: 'webcam-presets-unsupported',
          target: {id: resolved.item.id, name: resolved.item.name, slug: resolved.item.slug || null},
        })
      }
      throw error
    }
    const lines = result.presets.length
      ? result.presets.map((item, index) => `${index + 1}. ${item.name || `Preset ${item.token}`} (token ${item.token})`)
      : ['Nessun preset disponibile.']
    return response('webcam-presets', [`Preset di ${resolved.item.name}:`, ...lines].join('\n'), {type: 'webcam-presets', item: result})
  }

  if (/\b(diagnostic[ao]|onvif|firmware|seriale|info(?:rmazioni)?\s+dispositivo|device\s+info)\b/i.test(String(message || ''))) {
    const target = extractDiagnosticTarget(message)
    if (!target) return response('clarification', 'Di quale webcam vuoi leggere la diagnostica ONVIF?', {type: 'clarification', reason: 'missing-webcam-target'})
    const resolved = resolveTarget(webcams, target)
    if (resolved.status !== 'resolved') {
      const options = resolved.items?.map((item, index) => `${index + 1}. ${item.name} (${item.slug || 'senza slug'})`) || []
      return response('clarification', resolved.status === 'ambiguous' ? `Ho trovato più webcam:\n${options.join('\n')}\nIndica nome o slug esatto.` : `Non ho trovato una webcam corrispondente a “${target}”.`, {type: 'clarification', reason: `webcam-${resolved.status}`})
    }
    const result = await executeInspect({token, webcamId: resolved.item.id})
    const lines = [
      `Diagnostica ONVIF di ${resolved.item.name}:`,
      `- modello: ${result.modelNumber || 'non disponibile'}`,
      `- firmware: ${result.firmwareVersion || 'non disponibile'}`,
      `- seriale: ${result.serialNumber || 'non disponibile'}`,
      `- versione ONVIF: ${result.onvifVersion || 'non disponibile'}`,
    ]
    return response('webcam-device-info', lines.join('\n'), {type: 'webcam-device-info', item: result})
  }

  if (!/\b(riavvia|reboot)\b/i.test(String(message || ''))) return null
  const target = extractRebootTarget(message)
  if (!target) return response('clarification', 'Quale webcam vuoi riavviare? Indica nome o slug.', {type: 'clarification', reason: 'missing-webcam-target'})
  const resolved = resolveTarget(webcams, target)
  if (resolved.status !== 'resolved') {
    const options = resolved.items?.map((item, index) => `${index + 1}. ${item.name} (${item.slug || 'senza slug'})`) || []
    return response('clarification', resolved.status === 'ambiguous' ? `Ho trovato più webcam:\n${options.join('\n')}\nIndica nome o slug esatto.` : `Non ho trovato una webcam corrispondente a “${target}”.`, {type: 'clarification', reason: `webcam-${resolved.status}`})
  }

  const proposal = {operation: 'webcam-reboot', webcamId: resolved.item.id, name: resolved.item.name, actorFingerprint: fingerprintToken(token), expiresAt: Date.now() + PROPOSAL_TTL_MS}
  const opaqueToken = randomUUID()
  proposals.set(opaqueToken, proposal)
  auditAction('proposed', proposal)
  return response('webcam-reboot-preview', `Sto per riavviare ${proposal.name} (${resolved.item.slug || proposal.webcamId}). Lo stream potrebbe interrompersi per alcuni minuti. Scrivi “confermo” per procedere oppure “annulla”.`, {
    type: 'action-proposal', operation: 'webcam-reboot', proposalToken: opaqueToken, expiresAt: new Date(proposal.expiresAt).toISOString(), target: {id: proposal.webcamId, name: proposal.name, slug: resolved.item.slug || null}, confirmationRequired: true,
  })
}

function response(intent, reply, data) {
  return {ok: true, intent, source: 'tool-fast', reply, data, meta: {moduleId: 'facile.webcamgo', intent, source: 'tool-fast'}}
}
