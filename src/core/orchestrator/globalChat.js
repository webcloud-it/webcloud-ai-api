import {buildCapabilitySummary, getAvailableModuleIds} from '../capabilities/catalog.js'
import {normalizeSearchText, normalizeText} from '../../utils/text.js'
import {getEntityModuleId} from '../context/pageContext.js'

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
    /\bminisit[oi]\b.{0,40}\b(?:apert[oi]|chius[oi])\b/,
    /\bminisit[oi]\b.{0,40}\b(?:orari|apert\w*|chius\w*|apre|chiude)\b/,
    /\b(?:orari|apert\w*|chius\w*|apre|chiude)\b.{0,40}\bminisit[oi]\b/,
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
    /\b(?:statistic\w*|performance|invii?)\b.{0,50}\b(?:apertur[ae]|click|consegn\w*|bounce|destinatar\w*)\b/,
    /\b(?:tasso|percentuale)\s+(?:di\s+)?(?:apertura|click|consegna|rimbalzo)\b/,
    /\b(?:ticket|help\s*desk|zammad)\b/,
    /\b(?:assistenza|supporto)\b.{0,40}\b(?:client[ei]|utent[ei]|send\s*in\s*italy)\b/,
    /\brichiest\w*\b.{0,50}\b(?:rispost\w*|operatore|gestire)\b/,
  ],
  'facile.webcamgo': [
    /\bwebcam(?:go)?\b/,
    /\btelecamer[ae]\b/,
    /\bsnapshot\b/,
    /\bstream\b/,
    /\bptz\b/,
    /\bmikrotik\b/,
    /\bconnettivit[aà]\b/,
    /\boffline\b/,
    /\b(?:ultimo|recente)\b.{0,32}\b(?:evento|stato|periodo)\b.{0,24}\boffline\b/,
  ],
  'facile.renewals': [
    /\brinnov\w*/,
    /\b(?:scadenz\w*|scad(?:e|ono|r[aà]|ranno|ut[oaie]))\b/,
    /\bservizi?\b/,
    /\bgrupp[oi]\b/,
    /\bfornitor/,
    /\bpiani?\b/,
    /\badd[- ]?on\b/,
    /\bcomponenti\s+aggiuntiv[ei]\b/,
    /\b(?:prezz[oi]|cost[oi]|tariff[ae])\b.{0,48}\b(?:piani?|add[- ]?on|listino)\b/,
    /\bplesk\b/,
    /\bfattur/,
    /\bnon rinnovare\b/,
    /\b(?:spazio|quota|disco)\b.{0,48}\b(?:esaurit|pien|finit|satur)/,
    /\b(?:esaurit|pien|finit|satur)\w*\b.{0,48}\b(?:spazio|quota|disco)\b/,
  ],
}

const HELP_PATTERN = /^\s*(?:cosa puoi fare|come puoi aiutarmi|quali (?:funzioni|capacit[aà]|strumenti) (?:hai|sono disponibili))(?:\s+su\s+[\w .-]+)?\s*[?!.]?\s*$/i
const GREETING_PATTERN = /^\s*(?:ciao|salve|buongiorno|buonasera|hey|ehi)\s*[!,.]?\s*$/i
const HISTORY_COMMAND_PATTERN = /^\s*(?:(?:mostra|mostrami|fammi\s+vedere)\s+)?(?:(?:gli|le|i)\s+)?(?:altr[ei]|successiv[ei]|prossim[ei]|precedent[ei])(?:\s+(?:\d{1,2}|[a-z]+))?\s*[?!.]?\s*$/i
const CROSS_MODULE_WRITE_PATTERN = /\b(?:invia|manda|rispondi|pubblica|crea|aggiungi|modifica|aggiorna|imposta|elimina|cancella|chiudi|riapri|assegna|rinnova|riavvia|reboot|spegni|accendi|attiva|disattiva|sposta|lancia|pulisci|svuota|confermo)\b/i

// Fase transitoria: il routing applicativo resta deterministico solo quando
// la richiesta esprime chiaramente una consultazione/azione sui dati Webcloud.
// Tutto il resto va direttamente alla conversazione LLM, senza un planner LLM preliminare.
const GENERAL_CONVERSATION_PATTERN = /^\s*(?:chi\s+sei|cosa\s+sei|cos[’']?è|che\s+cos[’']?è|cosa\s+significa|spieg(?:a|ami)|come\s+funziona|perch[eé]|come\s+si\b|scriv(?:i|imi)|riscriv(?:i|imi)|corregg(?:i|imi)|traduc(?:i|imi)|genera|fammi\s+(?:un|una)|dammi\s+un\s+esempio|aiutami\s+a\s+(?:scrivere|capire|spiegare))\b/i
const APPLICATION_LOOKUP_PATTERN = /\b(?:quali?|quante?|quanti?|quanto|mostra(?:mi)?|elenca(?:mi)?|cerca|trova|conta|dimmi|dammi|controlla|verifica|analizza|riepiloga|riassumi|dettagli?|stato|situazione|ultimo|ultima|ultimi|ultime|offline|scad(?:e|ono|r[aà]|ranno|ut[oaie])|in\s+scadenza)\b/i
const INTERNAL_RELATION_PATTERN = /\b(?:servizi?|domini?|rinnovi?|scadenze?|fatture?|piani?|fornitori?|clienti?|gruppi?|webcam|telecamere?|campagne?|newsletter|ticket|mittenti?|eventi?|minisiti?|redirects?|assenze?|ferie|malattie|automazioni?)\b.{0,72}\b(?:di|del|della|dei|degli|delle|cliente|gruppo|account|utente)\b/i

function hasClearApplicationIntent(message = '') {
  const text = String(message || '')
  return APPLICATION_LOOKUP_PATTERN.test(text) || CROSS_MODULE_WRITE_PATTERN.test(text) || INTERNAL_RELATION_PATTERN.test(text)
}

const EXPLICIT_MODULE_PATTERNS = [
  ['facile.sendinitaly', /\bsend\s*in\s*italy\b/i],
  ['facile.webcamgo', /\bwebcamgo\b/i],
  ['facile.asiago', /\basiago\.it\b/i],
  ['facile.businesshours', /\bbusiness\s*hours?\b/i],
  ['facile.renewals', /\b(?:pannello\s+)?rinnovi\b/i],
]

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

function agentModuleFromHistory(history = []) {
  for (const item of (Array.isArray(history) ? history : []).slice(-6).reverse()) {
    const meta = item?.meta || item?.data?.meta || {}
    const source = item?.source || item?.data?.source || null
    const moduleId = meta?.moduleId || null
    const isAgentTurn = source === 'agent' || meta?.orchestrator === 'agent-v1'

    if (isAgentTurn && moduleId) return moduleId
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

function moduleFromExplicitBrand(message = '') {
  return EXPLICIT_MODULE_PATTERNS.find(([, pattern]) => pattern.test(String(message || '')))?.[0] || null
}

function isConfidentDeterministicModulePlan(message = '', plan = {}) {
  if (plan.type !== 'module' || plan.source !== 'message' || !plan.moduleId) return false

  const matchedModules = scoreModules(message).filter(candidate => candidate.score > 0)

  return matchedModules.length === 1 && matchedModules[0].moduleId === plan.moduleId
}

const LOCAL_ENTITY_REQUEST = /\b(?:dettagli?|informazioni?|info|scheda|stat[oi]|situazione|come\s+(?:sta|stanno)|funziona|problemi?|controlla|verifica|analizza|apri|mostra(?:mi)?|questa?|questo|corrente|attuale)\b/i

const STRONG_DOMAIN_PATTERNS = {
  'facile.webcamgo': /\b(?:webcamgo|webcam|telecamer[ae]|snapshot|stream|offline|ptz|mikrotik)\b/i,
  'facile.renewals': /\b(?:rinnov\w*|scadenz\w*|scad(?:e|ono|r[aà]|ranno|ut[oaie])|fornitor\w*|piani?|add[- ]?on|componenti\s+aggiuntiv[ei]|plesk|fattur\w*|non\s+rinnovare|spazio|quota|disco|esaurit\w*|satur\w*)\b|\bservizi?\b.{0,64}\b(?:grupp[oi]|groups?|client[ei]|fornitor[ei])\b|\b(?:grupp[oi]|groups?|client[ei]|fornitor[ei])\b.{0,64}\bservizi?\b/i,
  'facile.sendinitaly': /\b(?:send\s*in\s*italy|newsletter|campagn[ae]|postal|mittent[ei]|ticket|help\s*desk|zammad)\b|\b(?:assistenza|supporto)\b.{0,40}\b(?:client[ei]|utent[ei])\b|\brichiest\w*\b.{0,50}\b(?:rispost\w*|operatore|gestire)\b|\b(?:statistic\w*|performance|invii?)\b.{0,50}\b(?:apertur[ae]|click|consegn\w*|bounce|destinatar\w*)\b|\b(?:tasso|percentuale)\s+(?:di\s+)?(?:apertura|click|consegna|rimbalzo)\b/i,
  'facile.businesshours': /\b(?:orari|apertura|aperture|chiusura|chiusure|apre|chiude)\b|\bminisit[oi]\b.{0,40}\b(?:apert\w*|chius\w*)\b/i,
  'facile.asiago': /\b(?:cms|event[oi]|manifestazion[ei]|minisit[oi]|contenut[oi]|articol[oi]|bollettino|listini?|redirects?)\b/i,
  'facile.webcloud': /\b(?:assets?|wam|cloudflare|cache|festivit[aà]|ferie|malatti[ae]|automazion[ei]|mattemation|workflow|chatbot)\b/i,
}

const CONTEXTUAL_DOMAIN_PATTERNS = {
  'facile.sendinitaly': /\b(?:utent[ei]?|account|client[ei]|piani?|campagn[ae]|newsletter|invii?|statistic\w*|performance|apertur[ae]|click|consegn\w*|bounce|mittent[ei]|dns|spf|dkim|ticket|assistenza|supporto)\b|\brichiest\w*\b.{0,50}\b(?:rispost\w*|operatore|gestire)\b/i,
  'facile.renewals': /\b(?:servizi?|domini?|rinnov\w*|scadenz\w*|scad\w*|piani?|fornitor\w*|client[ei]|grupp[oi]|plesk|fattur\w*|spazio|quota|disco)\b/i,
  'facile.webcamgo': /\b(?:webcam|telecamer[ae]|stream|snapshot|router|mikrotik|connettivit[aà]|offline|ptz|preset)\b/i,
  'facile.businesshours': /\b(?:orari|apertur[ae]|chiusur[ae]|apre|chiude|minisit[oi])\b/i,
  'facile.asiago': /\b(?:event[oi]|manifestazion[ei]|contenut[oi]|articol[oi]|bollettino|neve|listini?|redirects?|minisit[oi])\b/i,
  'facile.webcloud': /\b(?:assets?|wam|cloudflare|cache|festivit[aà]|ferie|malatti[ae]|automazion[ei]|workflow|chatbot)\b/i,
}

function moduleFromContextualRequest(message = '', context = {}) {
  const moduleId = moduleFromContext(context)
  return moduleId && CONTEXTUAL_DOMAIN_PATTERNS[moduleId]?.test(String(message || ''))
    ? moduleId
    : null
}

function moduleFromStrongDomain(message = '') {
  const matches = Object.entries(STRONG_DOMAIN_PATTERNS)
    .filter(([, pattern]) => pattern.test(String(message || '')))
    .map(([moduleId]) => moduleId)

  return matches.length === 1 ? matches[0] : null
}

export function planDeterministicMultiModuleRead(message = '', credentials = {}) {
  if (CROSS_MODULE_WRITE_PATTERN.test(String(message || ''))) return null

  const clauses = String(message || '')
    .split(/\s+(?:e|inoltre|poi)\s+|[;,]+/i)
    .map(clause => clause.trim().replace(/^[,.!?]+|[,.!?]+$/g, ''))
    .filter(clause => clause.length >= 3)
  if (clauses.length < 2) return null

  const assigned = clauses.flatMap(clause => {
    const moduleIds = Object.entries(STRONG_DOMAIN_PATTERNS)
      .filter(([, pattern]) => pattern.test(clause))
      .map(([moduleId]) => moduleId)
    return moduleIds.length === 1 ? [{moduleId: moduleIds[0], clause}] : []
  })
  const moduleIds = [...new Set(assigned.map(item => item.moduleId))]
  if (moduleIds.length < 2) return null

  const availableModuleIds = getAvailableModuleIds({credentials})
  const unavailableModuleId = moduleIds.find(moduleId => !availableModuleIds.includes(moduleId))
  if (unavailableModuleId) {
    return {
      type: 'unavailable',
      reason: 'credential-unavailable',
      moduleId: unavailableModuleId,
      availableModuleIds,
    }
  }

  const tasks = moduleIds.map(moduleId => {
    const relevantClauses = assigned
      .filter(item => item.moduleId === moduleId)
      .map(item => item.clause)
    let canonicalMessage = relevantClauses.join(' e ')
    if (!/^(?:quali|quante|quanti|quanto|mostra|mostrami|elenca|elencami|cerca|trova|conta|dimmi|dammi|confronta|analizza|riassumi|riepiloga)\b/i.test(canonicalMessage)) {
      canonicalMessage = `mostrami ${canonicalMessage}`
    }
    return {moduleId, canonicalMessage, operation: 'read'}
  })

  return {
    type: 'multi-module',
    moduleId: moduleIds[0],
    secondaryModuleIds: moduleIds.slice(1),
    tasks,
    source: 'deterministic-multi',
    confidence: 1,
  }
}

export function validateSemanticModuleSelection(message = '', semantic = null) {
  if (semantic?.mode !== 'tool' || !semantic.moduleId) {
    return {valid: true, requiredModuleId: null}
  }

  const requiredModuleId = moduleFromStrongDomain(message)
  const selectedModuleIds = [semantic.moduleId, ...(semantic.secondaryModuleIds || [])]

  return {
    valid: !requiredModuleId || selectedModuleIds.includes(requiredModuleId),
    requiredModuleId,
  }
}

function moduleFromActiveEntityRequest(message = '', context = {}) {
  const entityModuleId = getEntityModuleId(context)
  if (!entityModuleId || !LOCAL_ENTITY_REQUEST.test(message)) return null

  const hasForeignDomain = Object.entries(STRONG_DOMAIN_PATTERNS).some(([moduleId, pattern]) => {
    return moduleId !== entityModuleId && pattern.test(message)
  })

  return hasForeignDomain ? null : entityModuleId
}

function hasExplicitActiveEntityReference(message = '') {
  return /\b(?:quest[oa](?:\s+(?:qui|webcam|telecamera|servizio|cliente|gruppo))?|quell[oa](?:\s+(?:webcam|telecamera|servizio|cliente|gruppo))?|(?:webcam|telecamera|servizio|cliente|gruppo)\s+(?:apert[oa]|corrente|attuale)|entit[aà]\s+corrente|pagina\s+corrente|esso|essa|lui|lei)\b/i.test(String(message || ''))
}

function isContextualModuleFastPath(message = '', plan = {}) {
  if (plan.type !== 'module' || !['history', 'context', 'active-entity'].includes(plan.source)) {
    return false
  }

  const patterns = {
    'facile.webcamgo': /\b(?:webcam|telecamer[ae]|stream|snapshot|router|mikrotik|connettivit[aà]|offline|fuori\s+linea|ptz|preset)\b/i,
    'facile.renewals': /\b(?:servizi?|domini?|rinnov\w*|scadenz\w*|scad(?:e|ono|r[aà]|ranno|ut[oaie])|piani?|fornitor\w*|plesk|fattur\w*|non\s+rinnovare|trasferire|spazio|quota|disco|esaurit\w*|satur\w*)\b/i,
    'facile.sendinitaly': CONTEXTUAL_DOMAIN_PATTERNS['facile.sendinitaly'],
    'facile.businesshours': CONTEXTUAL_DOMAIN_PATTERNS['facile.businesshours'],
    'facile.asiago': CONTEXTUAL_DOMAIN_PATTERNS['facile.asiago'],
    'facile.webcloud': CONTEXTUAL_DOMAIN_PATTERNS['facile.webcloud'],
  }

  return patterns[plan.moduleId]?.test(String(message || '')) === true
}

function isHistoryContinuationFastPath(message = '', plan = {}) {
  if (plan.type !== 'module' || plan.source !== 'history') return false
  if (HISTORY_COMMAND_PATTERN.test(String(message || ''))) return true

  return /^\s*(?:e|ed|ma|invece|ora|adesso|poi|tra\s+quest[ei]|fra\s+quest[ei]|di\s+quest[ei]|quest[ei]|quell[ei])\b/i.test(
    String(message || '')
  )
}

export function planGlobalChat({message = '', context = {}, history = [], credentials = {}} = {}) {
  const availableModuleIds = getAvailableModuleIds({credentials})
  const text = normalizeSearchText(message)
  const rawMessage = String(message || '').trim()

  const unsupportedDomain = UNSUPPORTED_DOMAINS.find(domain => domain.pattern.test(text))

  if (unsupportedDomain) {
    return {type: 'unsupported-domain', domain: unsupportedDomain}
  }

  if (HELP_PATTERN.test(text)) {
    return {type: 'help', capabilities: buildCapabilitySummary({credentials})}
  }

  if (GREETING_PATTERN.test(rawMessage)) {
    return {type: 'conversation', source: 'greeting'}
  }

  // Le richieste chiaramente generali (spiegazioni, scrittura, conoscenza)
  // non devono essere trascinate in un modulo solo per una parola coincidente.
  if (GENERAL_CONVERSATION_PATTERN.test(rawMessage)) {
    return {type: 'conversation', source: 'general'}
  }

  // Se il turno precedente è stato gestito dall'agente, i follow-up restano
  // nello stesso percorso agentico. Si esce solo davanti a un riferimento
  // inequivocabile a un altro modulo ancora gestito dal routing legacy.
  const agentHistoryModuleId = agentModuleFromHistory(history)

  if (agentHistoryModuleId) {
    const explicitBrandModuleId = moduleFromExplicitBrand(rawMessage)
    const strongDomainModuleId = moduleFromStrongDomain(text)
    const activeEntityModuleId = hasExplicitActiveEntityReference(rawMessage)
      ? getEntityModuleId(context)
      : null
    const requestedOtherModuleId = [
      explicitBrandModuleId,
      strongDomainModuleId,
      activeEntityModuleId,
    ].find(moduleId => moduleId && moduleId !== agentHistoryModuleId)

    if (!requestedOtherModuleId) {
      if (!availableModuleIds.includes(agentHistoryModuleId)) {
        return {
          type: 'unavailable',
          reason: 'credential-unavailable',
          moduleId: agentHistoryModuleId,
          availableModuleIds,
        }
      }

      return {type: 'conversation', source: 'agent-history'}
    }
  }

  // I follow-up operativi molto brevi devono continuare sul modulo precedente.
  const historyCommandModuleId = HISTORY_COMMAND_PATTERN.test(rawMessage)
    ? moduleFromHistory(history)
    : null

  if (historyCommandModuleId) {
    if (!availableModuleIds.includes(historyCommandModuleId)) {
      return {
        type: 'unavailable',
        reason: 'credential-unavailable',
        moduleId: historyCommandModuleId,
        availableModuleIds,
      }
    }

    return {type: 'module', moduleId: historyCommandModuleId, source: 'history'}
  }

  // Un riferimento esplicito all'entità aperta è anch'esso un follow-up applicativo.
  const entityModuleId = moduleFromActiveEntityRequest(text, context)
  if (entityModuleId && hasExplicitActiveEntityReference(rawMessage)) {
    if (!availableModuleIds.includes(entityModuleId)) {
      return {
        type: 'unavailable',
        reason: 'credential-unavailable',
        moduleId: entityModuleId,
        availableModuleIds,
      }
    }

    return {type: 'module', moduleId: entityModuleId, source: 'active-entity'}
  }

  // Finché il tool calling nativo non è attivo, preserviamo le richieste
  // applicative inequivocabili con il routing esistente. Non usiamo però
  // l'LLM come classificatore separato.
  if (hasClearApplicationIntent(rawMessage)) {
    const deterministicMultiModulePlan = planDeterministicMultiModuleRead(message, credentials)
    if (deterministicMultiModulePlan) return deterministicMultiModulePlan

    const explicitBrandModuleId = moduleFromExplicitBrand(rawMessage)
    const contextualRequestModuleId = moduleFromContextualRequest(text, context)
    const strongDomainModuleId = moduleFromStrongDomain(text)
    const scores = scoreModules(text)
    const best = scores[0]
    const second = scores[1]

    let moduleId = null
    let source = null

    if (explicitBrandModuleId) {
      moduleId = explicitBrandModuleId
      source = 'message'
    } else if (contextualRequestModuleId) {
      moduleId = contextualRequestModuleId
      source = 'context'
    } else if (strongDomainModuleId) {
      moduleId = strongDomainModuleId
      source = 'message'
    } else if (best?.score > 0 && best.score > (second?.score || 0)) {
      moduleId = best.moduleId
      source = 'message'
    }

    if (moduleId) {
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
  }

  // Default fondamentale del nuovo flusso: se non abbiamo una richiesta
  // applicativa inequivocabile, parla direttamente con Qwen.
  return {type: 'conversation', source: 'default'}
}

export async function resolveGlobalChatPlan(options = {}) {
  // POST /api/chat invokes this only after CAPABILITY_NOT_MIGRATED.
  // These legacy linguistic rules never select or hide native agent tools.
  // Manteniamo la firma async per compatibilità con la route, ma non viene
  // eseguita alcuna inferenza di planning: una richiesta conversazionale
  // comporta una sola chiamata LLM, quella che genera la risposta.
  return planGlobalChat(options)
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
