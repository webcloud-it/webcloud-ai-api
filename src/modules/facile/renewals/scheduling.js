import {env} from '../../../config/env.js'
import {authHeaders, fetchJson, joinUrl} from '../../../utils/http.js'
import {ToolContractError} from '../../../core/tools/toolContract.js'

export function describeScheduledSend(send) {
  const validity = send.commercialValidity
  if (send.status === 'sent') return send.historySynced === false
    ? 'Email già inviata, ma registrazione dello storico da recuperare: si ripara soltanto lo storico, senza un nuovo invio.'
    : 'Invio già effettuato; l’identità commerciale del ciclo resta congelata.'
  const mismatch = validity?.status === 'mismatch' ? validity : send.blockedCommercialContext
  if (mismatch?.status === 'mismatch') {
    const changed = (mismatch.services ?? []).filter(s => s.commercialCustomerId !== s.currentCommercialCustomerId ||
      s.commercialGroupId !== s.currentCommercialGroupId)
    return 'Ciclo da rigenerare. ' + changed.map(s =>
      `${s.serviceName ?? s.serviceId}: preparato per ${s.commercialCustomerName ?? s.commercialCustomerId ?? 'cliente non verificabile'}, ora appartiene commercialmente a ${s.currentCommercialCustomerName ?? s.currentCommercialCustomerId ?? 'cliente non verificabile'}${s.commercialGroupId !== s.currentCommercialGroupId ? ` (gruppo commerciale: ${s.commercialGroupName ?? s.commercialGroupId ?? 'nessuno'} → ${s.currentCommercialGroupName ?? s.currentCommercialGroupId ?? 'nessuno'})` : ''}.`).join(' ')
  }
  if (validity?.status === 'unverifiable') return 'Identità commerciale o destinatario storico non dimostrabili: invio automatico bloccato, occorre rigenerare il ciclo.'
  return send.blockedReason ?? (send.cycleStatus === 'draft' ? 'Ciclo in bozza, non ancora attivato.' :
    send.status === 'blocked' ? 'Invio bloccato: verificare la programmazione.' : `Ciclo ${send.cycleStatus}, invio ${send.status}.`)
}

export async function readScheduling(args = {}, {read = async (path) => fetchJson(
  joinUrl(env.renewalsApiBaseUrl, path), {headers: authHeaders(env.crmToken), timeoutMs: env.crmFetchTimeoutMs || 10000},
  'Errore lettura programmazione rinnovi')} = {}) {
  if (Object.keys(args).some(k => !['cycleId', 'scope', 'status', 'page'].includes(k)) ||
    (args.cycleId && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args.cycleId)))
    throw new ToolContractError('INVALID_ARGUMENTS', 'Filtri programmazione non validi')
  const params = new URLSearchParams()
  for (const k of ['scope', 'status', 'page', 'cycleId']) if (args[k] != null) params.set(k, String(args[k]))
  const [operations, schedules] = await Promise.all([
    read('/services/renewals-scheduler/operations?' + params), read('/services/renewals-schedules'),
  ])
  // Cycle filtering applies to materialized sends, never to current service membership.
  const sends = (operations.sends ?? []).filter(s => !args.cycleId || s.cycle_id === args.cycleId)
    .map(s => ({...s, explanation: describeScheduledSend(s)}))
  return {schedules, ...operations, sends, cycleFilter: args.cycleId ?? null,
    note: 'Schedule = regola futura valutata sul cliente commerciale corrente. Cycle = preparazione congelata; commercialIdentity è storica, commercialValidity verifica la situazione corrente. Il cliente operativo Send in Italy/Plesk è distinto.'}
}

export const renewalsSchedulingTool = {
  name: 'renewals_read_scheduling', moduleId: 'facile.renewals', credential: 'crm',
  requiresPrincipal: true, capabilityId: 'facile.renewals.read', mode: 'read', risk: 'low',
  terminal: true, stateful: false,
  definition: {type: 'function', function: {
    name: 'renewals_read_scheduling',
    description: 'Consulta schedule, cicli e invii programmati; spiega perché un’offerta non è stata inviata e distingue identità commerciale congelata da cliente/gruppo correnti. Lettura senza invii o modifiche.',
    parameters: {type: 'object', additionalProperties: false, properties: {
      cycleId: {type: 'string', description: 'UUID del ciclo materializzato, se noto.'},
      scope: {type: 'string', description: 'Nome cliente o gruppo commerciale del ciclo.'},
      status: {type: 'string', enum: ['scheduled', 'processing', 'sent', 'blocked', 'uncertain', 'failed', 'cancelled']},
      page: {type: 'integer', minimum: 1},
    }, required: []},
  }},
  execute: async args => {
    const data = await readScheduling(args)
    return {ok: true, moduleId: 'facile.renewals', data,
      reply: data.sends.length ? data.sends.map(s => `${s.scheduleName} · ${s.scopeName}: ${s.explanation}`).join('\n') : 'Nessun invio in questa pagina per i filtri indicati.',
      modelContent: {type: 'renewals-scheduling-result', ...data}}
  },
}
