import {normalizeSearchText} from '../../../utils/text.js'
import {
  extractEntityTarget,
  isOpenEntityRequest,
  resolveNamedEntity,
} from '../../../core/entities/entityResolver.js'
import {getChatAuditSummary} from '../../../core/observability/chatAudit.js'
import {getAutomations, getCloudflareBuckets, getHolidays, getWamApplications, getWamAssets} from './service.js'
import {getOperationalOverview} from './operationalOverview.js'

function quoted(message = '') {
  return String(message).match(/["“”']([^"“”']{2,80})["“”']/)?.[1]?.trim() || ''
}

function unavailable(label, credential) {
  return {ok: true, intent: 'unavailable', source: 'tool-fast', reply: `La sessione non dispone della credenziale necessaria per ${label}. Ricarica Facile o verifica i permessi dell’account.`, data: {type: 'capability-unavailable', credential}, meta: {moduleId: 'facile.webcloud'}}
}

function navigation(label, path, moduleId = 'facile.webcloud') {
  const target = path && typeof path === 'object' ? path : {path}
  return {ok: true, intent: 'app-action', source: 'tool-fast', reply: `Apro ${label}.`, data: {type: 'app-action', appAction: {id: 'navigate', label: `Apri ${label}`, ...target}}, meta: {moduleId}}
}

function openCollection({message, result, type, label, path, fields}) {
  if (!isOpenEntityRequest(message)) return null
  const target = extractEntityTarget(message)
  const resolution = resolveNamedEntity({items: result.items || [], query: target, fields})

  if (resolution.status === 'resolved') {
    const item = resolution.item
    return navigation(label(item), path(item))
  }

  if (resolution.status === 'ambiguous') {
    const items = resolution.candidates.map(candidate => candidate.item)
    return {ok: true, intent: `${type}-open-ambiguous`, source: 'tool-fast', reply: [`Ho trovato più risultati per “${target}”. Scegli quello corretto:`, ...items.map((item, index) => `${index + 1}. ${label(item)}`)].join('\n'), data: {type, query: {search: target, intent: 'open'}, ...result, total: items.length, items}, meta: {moduleId: 'facile.webcloud'}}
  }

  return null
}

export async function handleWebcloudChat({message, credentials = {}, services = {getAutomations, getCloudflareBuckets, getHolidays, getWamApplications, getWamAssets, getOperationalOverview}} = {}) {
  const text = normalizeSearchText(message)
  const search = quoted(message) || (isOpenEntityRequest(message) ? extractEntityTarget(message) || '' : '')

  if (/\b(panoramica\s+operativa|stato\s+generale|ci\s+sono\s+problemi|alert|criticita\s+(?:globali|generali))\b/.test(text)) {
    const result = await services.getOperationalOverview({credentials})
    const high = result.alerts.filter(item => item.level === 'high').length
    const medium = result.alerts.filter(item => item.level === 'medium').length
    return {ok: true, intent: 'webcloud-operational-overview', source: 'tool-fast', reply: result.alerts.length ? [`Panoramica operativa: ${high} criticità alte e ${medium} avvisi.`, ...result.alerts.slice(0, 12).map(item => `- ${item.label}`)].join('\n') : `Panoramica operativa: nessuna criticità nelle ${result.availableSources} aree verificate.`, data: {type: 'webcloud-operational-overview', ...result}, meta: {moduleId: 'facile.webcloud'}}
  }

  if (/\b(chatbot|assistente\s+ai|audit\s+(?:della\s+)?chat|error[ei]\s+(?:della\s+)?chat)\b/.test(text)) {
    if (!credentials.crm) return unavailable('lo stato operativo del chatbot', 'crm')
    const result = getChatAuditSummary({windowMinutes: 60})
    return {
      ok: true,
      intent: 'webcloud-chat-audit',
      source: 'tool-fast',
      reply: result.requests
        ? `Chatbot nell’ultima ora: ${result.requests} richieste, ${result.successRate}% riuscite, media ${result.averageDurationMs} ms, ${result.failures} errori e ${result.slowRequests} richieste lente.`
        : 'Il chatbot non ha ancora registrato richieste nell’ultima ora.',
      data: {type: 'webcloud-chat-audit', ...result},
      meta: {moduleId: 'facile.webcloud'},
    }
  }

  if (/\b(cloudflare|cache|bucket)\b/.test(text)) {
    if (!credentials.crm) return unavailable('Cloudflare cache', 'crm')
    if (isOpenEntityRequest(message)) return navigation('Cloudflare cache', '/webcloud/cloudflare-cache')
    const result = await services.getCloudflareBuckets()
    return {ok: true, intent: 'webcloud-cache-buckets', source: 'tool-fast', reply: result.items.length ? [`Cache Cloudflare: ${result.total} bucket.`, ...result.items.map((item, index) => `${index + 1}. ${item.name} — aggiornato ${item.timestamp ? new Date(item.timestamp).toISOString().slice(0, 16).replace('T', ' ') : 'non disponibile'}`)].join('\n') : 'Non risultano bucket cache configurati.', data: {type: 'webcloud-cache-buckets', ...result, actions: [{id: 'navigate', label: 'Apri Cloudflare cache', path: '/webcloud/cloudflare-cache'}]}, meta: {moduleId: 'facile.webcloud'}}
  }

  if (/\b(festivita|ferie|malatti[ae]|assen[zt][ae]|calendario)\b/.test(text)) {
    if (!credentials.crm) return unavailable('il calendario festività', 'crm')
    if (isOpenEntityRequest(message)) return navigation('il calendario', '/webcloud/holidays')
    const result = await services.getHolidays({token: credentials.crm})
    return {ok: true, intent: 'webcloud-holidays', source: 'tool-fast', reply: result.items.length ? [`Calendario: ${result.total} ricorrenze o assenze nei prossimi sei mesi.`, ...result.items.map((item, index) => `${index + 1}. ${item.name} — ${item.type}, ${item.from}${item.to !== item.from ? ` → ${item.to}` : ''}`)].join('\n') : 'Non risultano festività o assenze nei prossimi sei mesi.', data: {type: 'webcloud-holidays', ...result, actions: [{id: 'navigate', label: 'Apri calendario', path: '/webcloud/holidays'}]}, meta: {moduleId: 'facile.webcloud'}}
  }

  if (/\b(automazion[ei]|mattemation|workflow)\b/.test(text)) {
    if (!credentials.nozomi) return unavailable('le automazioni', 'nozomi')
    const result = await services.getAutomations({token: credentials.nozomi, search})
    const openResult = openCollection({message, result, type: 'webcloud-automations', label: item => item.name || String(item.id), path: item => `/webcloud/mattemations/${encodeURIComponent(String(item.id))}`, fields: [{value: 'name', weight: 18}, {value: 'id', weight: 20}, {value: 'description', weight: 5}]})
    if (openResult) return openResult
    return {ok: true, intent: 'webcloud-automations', source: 'tool-fast', reply: result.items.length ? [`Automazioni disponibili: ${result.total}.`, ...result.items.map((item, index) => `${index + 1}. ${item.name} [${item.runnable ? 'eseguibile' : 'senza trigger'}]${item.inputs.length ? ` — ${item.inputs.length} input` : ''}`)].join('\n') : 'Non ho trovato automazioni corrispondenti.', data: {type: 'webcloud-automations', query: {search}, ...result}, meta: {moduleId: 'facile.webcloud'}}
  }

  if (/\b(asset|wam|immagin[ei]|media)\b/.test(text)) {
    if (!credentials.wam) return unavailable('Assets Manager', 'wam')
    if (/\b(applicazion[ei]|bucket)\b/.test(text) && !/\basset\b/.test(text)) {
      const result = await services.getWamApplications({token: credentials.wam, search})
      const openResult = openCollection({message, result, type: 'webcloud-wam-applications', label: item => item.name || String(item.id), path: item => `/webcloud/assets-manager/${encodeURIComponent(String(item.id))}`, fields: [{value: 'name', weight: 18}, {value: 'id', weight: 20}]})
      if (openResult) return openResult
      return {ok: true, intent: 'webcloud-wam-applications', source: 'tool-fast', reply: result.items.length ? [`WAM: ${result.total} applicazioni.`, ...result.items.map((item, index) => `${index + 1}. ${item.name}`)].join('\n') : 'Non ho trovato applicazioni WAM corrispondenti.', data: {type: 'webcloud-wam-applications', query: {search}, ...result, actions: [{id: 'navigate', label: 'Apri Assets Manager', path: '/webcloud/assets-manager'}]}, meta: {moduleId: 'facile.webcloud'}}
    }
    const applicationId = String(message).match(/\bapp(?:licazione)?\s+([a-z0-9-]{3,80})\b/i)?.[1] || ''
    const result = await services.getWamAssets({token: credentials.wam, applicationId, search})
    const openResult = openCollection({message, result, type: 'webcloud-wam-assets', label: item => item.title || item.shortId || String(item.id), path: item => ({path: `/webcloud/assets-manager/${encodeURIComponent(String(item.applicationId))}/assets`, query: {asset: String(item.shortId)}}), fields: [{value: 'title', weight: 18}, {value: 'shortId', weight: 20}, {value: 'id', weight: 16}]})
    if (openResult) return openResult
    return {ok: true, intent: 'webcloud-wam-assets', source: 'tool-fast', reply: result.items.length ? [`WAM: ${result.total} asset.`, ...result.items.map((item, index) => `${index + 1}. ${item.title}${item.shortId ? ` (${item.shortId})` : ''}${item.width && item.height ? ` — ${item.width}×${item.height}` : ''}`)].join('\n') : 'Non ho trovato asset WAM corrispondenti.', data: {type: 'webcloud-wam-assets', query: {search, applicationId}, ...result, actions: [{id: 'navigate', label: 'Apri Assets Manager', path: '/webcloud/assets-manager'}]}, meta: {moduleId: 'facile.webcloud'}}
  }

  return {ok: true, intent: 'clarification', source: 'tool-fast', reply: 'Posso consultare Assets Manager/WAM, cache Cloudflare, calendario festività e automazioni. Quale area vuoi controllare?', data: {type: 'clarification', reason: 'webcloud-area-required'}, meta: {moduleId: 'facile.webcloud'}}
}
