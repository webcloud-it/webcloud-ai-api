import {buildCapabilitySummary, getAvailableModuleIds} from '../capabilities/catalog.js'
import {normalizeSearchText, normalizeText} from '../../utils/text.js'
import {callOllamaJson} from '../providers/ollamaProvider.js'
import {getEntityModuleId} from '../context/pageContext.js'
import {isSemanticFastPath, planSemanticRequest} from '../planner/semanticRequestPlanner.js'

const DOMAIN_PATTERNS = {
  'facile.webcloud': [
    /\bassets?\b/,
    /\bwam\b/,
    /\bimmagin[ei]\b/,
    /\bcloudflare\b/,
    /\bcache\b/,
    /\bbuckets?\b/,
    /\bfestivita\b/,
    /\bferie\b/,
    /\bmalatti[ae]\b/,
    /\bautomazion[ei]\b/,
    /\bmattemation\b/,
    /\bworkflow\b/,
    /\bchatbot\b/,
    /\bassistente\s+ai\b/,
    /\baudit\s+(?:della\s+)?chat\b/,
    /\berror[ei]\s+(?:della\s+)?chat\b/,
    /\bpanoramica\s+operativa\b/,
    /\bstato\s+generale\b/,
    /\bci\s+sono\s+problemi\b/,
    /\balerts?\b/,
  ],
  'facile.businesshours': [
    /\borari\b/,
    /\bapertur[aeo]\b/,
    /\bchiusur[aeo]\b/,
    /\bminisit[oi]\b.{0,40}\b(?:orari|apert|chius|apre|chiude)\b/,
    /\b(?:orari|apert|chius|apre|chiude)\b.{0,40}\bminisit[oi]\b/,
    /\b(?:quando|a\s+che\s+ora)\b.{0,24}\b(?:apre|chiude)\b/,
  ],
  'facile.asiago': [
    /\basiago(?:\.it)?\b/,
    /\bcms\b/,
    /\bevent[oi]\b/,
    /\bmanifestazion[ei]\b/,
    /\bminisit[oi]\b/,
    /\bcontenut[oi]\b/,
    /\barticol[oi]\b/,
    /\bbollettino\b/,
    /\bneve\b/,
    /\blistini?\b/,
    /\bredirects?\b/,
    /\breindirizzament[oi]\b/,
  ],
  'facile.sendinitaly': [
    /\bsend\s*in\s*italy\b/,
    /\bnewsletter\b/,
    /\bcampagn[ae]\b/,
    /\bpostal\b/,
    /\bmittent[ei]\b/,
  ],
  'facile.webcamgo': [
    /\bwebcam(?:go)?\b/,
    /\btelecamer[ae]\b/,
    /\bsnapshot\b/,
    /\bstream\b/,
    /\bptz\b/,
    /\bmikrotik\b/,
    /\bconnettivit[aà]\b/,
  ],
  'facile.renewals': [
    /\brinnov/,
    /\bscadenz/,
    /\bservizi?\b/,
    /\bgrupp[oi]\b/,
    /\bfornitor/,
    /\bpiani?\b/,
    /\bplesk\b/,
    /\bfattur/,
    /\bnon rinnovare\b/,
  ],
}

const HELP_PATTERN = /^\s*(?:cosa puoi fare|come puoi aiutarmi|quali (?:funzioni|capacit[aà]|strumenti) (?:hai|sono disponibili))(?:\s+su\s+[\w .-]+)?\s*[?!.]?\s*$/i
const GREETING_PATTERN = /^\s*(?:ciao|salve|buongiorno|buonasera|hey|ehi)\s*[!,.]?\s*$/i

const UNSUPPORTED_DOMAINS = [
]

function moduleFromContext(context = {}) {
  const explicit = context.activeModuleId || context.moduleId

  if (
    explicit &&
    ['facile.renewals', 'facile.webcamgo', 'facile.sendinitaly', 'facile.businesshours', 'facile.asiago', 'facile.webcloud'].includes(explicit)
  ) {
    return explicit
  }

  const section = normalizeText(`${context.section || ''} ${context.path || ''}`)

  if (section.includes('webcamgo')) return 'facile.webcamgo'
  if (section.includes('sendinitaly')) return 'facile.sendinitaly'
  if (section.includes('minisite') && (section.includes('hour') || section.includes('orari'))) {
    return 'facile.businesshours'
  }
  if (section.includes('asiagoit') || section.includes('cms')) return 'facile.asiago'
  if (section.includes('/webcloud') || section.includes('assets-manager') || section.includes('cloudflare')) return 'facile.webcloud'
  if (section.includes('renewal') || section.includes('/crm')) return 'facile.renewals'

  return null
}

function unsupportedDomainFromContext(context = {}) {
  const value = normalizeText(`${context.section || ''} ${context.path || ''}`)

  return null
}

function moduleFromHistory(history = []) {
  for (const item of [...history].reverse()) {
    const moduleId = item?.meta?.moduleId || item?.data?.meta?.moduleId

    if (['facile.renewals', 'facile.webcamgo', 'facile.sendinitaly', 'facile.businesshours', 'facile.asiago', 'facile.webcloud'].includes(moduleId)) {
      return moduleId
    }

    const dataType = String(item?.data?.type || '')
    if (dataType.startsWith('webcam')) return 'facile.webcamgo'
    if (dataType.startsWith('sendinitaly')) return 'facile.sendinitaly'
    if (dataType.startsWith('business-hours')) return 'facile.businesshours'
    if (dataType.startsWith('asiago-')) return 'facile.asiago'
    if (dataType.startsWith('webcloud-')) return 'facile.webcloud'
  }

  return null
}

function scoreModules(message = '') {
  const text = normalizeSearchText(message)

  return Object.entries(DOMAIN_PATTERNS)
    .map(([moduleId, patterns]) => ({
      moduleId,
      score: patterns.reduce((total, pattern) => total + (pattern.test(text) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score)
}

const LOCAL_ENTITY_REQUEST = /\b(?:dettagli?|informazioni?|info|scheda|stat[oi]|situazione|come\s+(?:sta|stanno)|funziona|problemi?|controlla|verifica|analizza|apri|mostra(?:mi)?|questa?|questo|corrente|attuale)\b/i

const STRONG_DOMAIN_PATTERNS = {
  'facile.webcamgo': /\b(?:webcamgo|webcam|telecamer[ae]|snapshot|stream|ptz|mikrotik)\b/i,
  'facile.renewals': /\b(?:rinnov|scadenz|fornitor|piani?|plesk|fattur|non\s+rinnovare)\b/i,
  'facile.sendinitaly': /\b(?:send\s*in\s*italy|newsletter|campagn[ae]|postal|mittent[ei])\b/i,
  'facile.businesshours': /\b(?:orari|apertur[aeo]|chiusur[aeo]|apre|chiude)\b/i,
  'facile.asiago': /\b(?:cms|event[oi]|manifestazion[ei]|minisit[oi]|contenut[oi]|articol[oi]|bollettino|listini?|redirects?)\b/i,
  'facile.webcloud': /\b(?:assets?|wam|cloudflare|cache|festivit[aà]|ferie|malatti[ae]|automazion[ei]|mattemation|workflow|chatbot)\b/i,
}

function moduleFromActiveEntityRequest(message = '', context = {}) {
  const entityModuleId = getEntityModuleId(context)
  if (!entityModuleId || !LOCAL_ENTITY_REQUEST.test(message)) return null

  const hasForeignDomain = Object.entries(STRONG_DOMAIN_PATTERNS).some(([moduleId, pattern]) => {
    return moduleId !== entityModuleId && pattern.test(message)
  })

  return hasForeignDomain ? null : entityModuleId
}

export function planGlobalChat({message = '', context = {}, history = [], credentials = {}} = {}) {
  const availableModuleIds = getAvailableModuleIds({credentials})
  const text = normalizeText(message)

  const unsupportedDomain = UNSUPPORTED_DOMAINS.find(domain => domain.pattern.test(text))

  if (unsupportedDomain) {
    return {type: 'unsupported-domain', domain: unsupportedDomain}
  }

  if (HELP_PATTERN.test(text)) {
    return {type: 'help', capabilities: buildCapabilitySummary({credentials})}
  }

  if (GREETING_PATTERN.test(String(message || '').trim())) {
    return {type: 'greeting'}
  }

  const entityModuleId = moduleFromActiveEntityRequest(text, context)
  const scores = scoreModules(text)
  const best = scores[0]
  const second = scores[1]

  let moduleId = null
  let source = null

  if (entityModuleId) {
    moduleId = entityModuleId
    source = 'active-entity'
  } else if (best?.score > 0 && best.score > (second?.score || 0)) {
    moduleId = best.moduleId
    source = 'message'
  } else {
    moduleId = moduleFromHistory(history)
    source = moduleId ? 'history' : null
  }

  if (!moduleId) {
    moduleId = moduleFromContext(context)
    source = moduleId ? 'context' : null
  }

  if (!moduleId && availableModuleIds.length === 1) {
    moduleId = availableModuleIds[0]
    source = 'only-available'
  }

  if (!moduleId) {
    const contextDomain = unsupportedDomainFromContext(context)

    if (contextDomain) {
      return {type: 'unsupported-domain', domain: contextDomain}
    }

    return {type: 'clarification', reason: 'domain-required', availableModuleIds}
  }

  if (!availableModuleIds.includes(moduleId)) {
    return {
      type: 'unavailable',
      reason: 'credential-unavailable',
      moduleId,
      availableModuleIds,
    }
  }

  return {type: 'module', moduleId, source}
}

export async function resolveGlobalChatPlan(options = {}, callModel = callOllamaJson) {
  const deterministicPlan = planGlobalChat(options)

  if (
    ['greeting', 'help', 'unsupported-domain'].includes(deterministicPlan.type) ||
    isSemanticFastPath(options.message) ||
    (deterministicPlan.type === 'module' && deterministicPlan.source === 'active-entity')
  ) {
    return deterministicPlan
  }

  const availableModuleIds = getAvailableModuleIds({credentials: options.credentials || {}})
  if (!availableModuleIds.length || typeof callModel !== 'function') return deterministicPlan

  try {
    const semantic = await planSemanticRequest({
      message: options.message,
      context: options.context,
      history: options.history,
      availableModuleIds,
    }, callModel)

    if (semantic?.mode === 'conversation' && semantic.confidence >= 0.72 && deterministicPlan.type === 'clarification') {
      return {type: 'conversation', source: 'semantic', semantic}
    }

    if (semantic?.mode === 'clarification' && semantic.confidence >= 0.72 && deterministicPlan.type === 'clarification') {
      return {...deterministicPlan, type: 'clarification', availableModuleIds, source: 'semantic', semantic}
    }

    if (semantic?.mode === 'tool' && semantic.confidence >= 0.72) {
      if (!semantic.available) {
        return {type: 'unavailable', moduleId: semantic.moduleId, availableModuleIds, source: 'semantic', semantic}
      }

      return {
        type: semantic.secondaryModuleIds.length ? 'multi-module' : 'module',
        moduleId: semantic.moduleId,
        secondaryModuleIds: semantic.secondaryModuleIds,
        canonicalMessage: semantic.canonicalMessage,
        source: 'semantic',
        confidence: semantic.confidence,
        semantic,
      }
    }
  } catch (_) {
    // Il percorso deterministico resta un fallback completo se Ollama non è disponibile.
  }

  return deterministicPlan
}

export function buildGlobalConversationResponse() {
  return {
    ok: true,
    intent: 'conversation',
    source: 'semantic',
    reply: 'Prego! Sono qui: dimmi pure cosa vuoi controllare o fare in Facile.',
    data: {type: 'conversation'},
    meta: {moduleId: 'facile', orchestrator: 'global-v2', routingSource: 'semantic'},
  }
}

export function buildMultiModuleResponse({moduleId, secondaryModuleIds = []} = {}) {
  const all = [moduleId, ...secondaryModuleIds].filter(Boolean)
  return {
    ok: true,
    intent: 'clarification',
    source: 'semantic',
    reply: `Ho riconosciuto ${all.length} obiettivi in aree diverse. Per evitare di ignorarne uno, indicami quale vuoi eseguire per primo: ${all.join(' oppure ')}.`,
    data: {type: 'clarification', reason: 'multi-module-request', options: all},
    meta: {moduleId: 'facile', orchestrator: 'global-v2', routingSource: 'semantic'},
  }
}

export function buildGlobalGreetingResponse({credentials = {}} = {}) {
  const capabilities = buildCapabilitySummary({credentials})
  const labels = capabilities.map(item => item.title)

  return {
    ok: true,
    intent: 'greeting',
    source: 'global',
    reply: labels.length
      ? `Ciao! Posso aiutarti trasversalmente con ${labels.join(' e ')}. Chiedimi pure un’informazione o un’operazione; se modifica dati ti mostrerò prima un’anteprima da confermare.`
      : 'Ciao! Al momento non risultano strumenti disponibili per questa sessione. Prova a ricaricare Facile o ad autenticarti nuovamente.',
    data: {type: 'greeting', areas: labels},
    meta: {moduleId: 'facile', orchestrator: 'global-v1'},
  }
}

export function buildUnsupportedDomainResponse({domain} = {}) {
  return {
    ok: true,
    intent: 'unsupported-domain',
    source: 'global',
    reply: `Ho capito che la richiesta riguarda ${domain?.label || 'un’area Webcloud'}. Quest’area non è ancora collegata al nuovo orchestratore e non proverò a inventare dati o azioni.`,
    data: {type: 'capability-unavailable', domain: domain?.id || null},
    meta: {moduleId: 'facile', orchestrator: 'global-v1'},
  }
}

export function buildGlobalHelpResponse({credentials = {}} = {}) {
  const capabilities = buildCapabilitySummary({credentials})

  if (!capabilities.length) {
    return {
      ok: true,
      intent: 'capabilities',
      source: 'global',
      reply: 'Non risultano strumenti disponibili per questa sessione. Prova a ricaricare Facile o ad autenticarti nuovamente.',
      data: {type: 'capabilities', items: []},
      meta: {moduleId: 'facile', orchestrator: 'global-v1'},
    }
  }

  const lines = capabilities.map(item => {
    return `- ${item.title}: ${[...new Set(item.descriptions)].join(' ')}`
  })

  return {
    ok: true,
    intent: 'capabilities',
    source: 'global',
    reply: [
      'Posso lavorare trasversalmente nelle aree Webcloud disponibili per il tuo account:',
      ...lines,
      '',
      'Le operazioni che modificano dati vengono sempre preparate e confermate prima dell’esecuzione.',
    ].join('\n'),
    data: {type: 'capabilities', items: capabilities},
    meta: {moduleId: 'facile', orchestrator: 'global-v1'},
  }
}

export function buildGlobalClarificationResponse({availableModuleIds = []} = {}) {
  const labels = availableModuleIds.map(id => {
    if (id === 'facile.webcamgo') return 'WebcamGo'
    if (id === 'facile.sendinitaly') return 'Send in Italy'
    if (id === 'facile.businesshours') return 'orari e aperture dei minisiti'
    if (id === 'facile.asiago') return 'Asiago.it e CMS'
    if (id === 'facile.webcloud') return 'strumenti Webcloud'
    return 'rinnovi e CRM'
  })

  return {
    ok: true,
    intent: 'clarification',
    source: 'global',
    reply: labels.length
      ? `La richiesta può riguardare più aree. Vuoi lavorare su ${labels.join(' oppure ')}?`
      : 'Non ho strumenti disponibili per questa sessione. Prova a ricaricare Facile o ad autenticarti nuovamente.',
    data: {type: 'clarification', reason: 'domain-required', options: availableModuleIds},
    meta: {moduleId: 'facile', orchestrator: 'global-v1'},
  }
}

export function buildUnavailableModuleResponse({moduleId} = {}) {
  const label =
    moduleId === 'facile.webcamgo'
      ? 'WebcamGo'
      : moduleId === 'facile.sendinitaly'
        ? 'Send in Italy'
        : moduleId === 'facile.asiago'
          ? 'Asiago.it e CMS'
        : moduleId === 'facile.webcloud'
          ? 'strumenti Webcloud'
        : moduleId === 'facile.businesshours'
          ? 'orari e aperture dei minisiti'
        : 'rinnovi e CRM'

  return {
    ok: true,
    intent: 'unavailable',
    source: 'global',
    reply: `Ho capito che la richiesta riguarda ${label}, ma questa sessione non dispone della credenziale necessaria. Ricarica Facile o verifica i permessi dell’account.`,
    data: {type: 'capability-unavailable', moduleId},
    meta: {moduleId: 'facile', orchestrator: 'global-v1'},
  }
}
