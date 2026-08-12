import {callOllamaJson} from '../providers/ollamaProvider.js'

const MODULES = {
  'facile.renewals': 'CRM, clienti, gruppi, servizi, domini, piani, fornitori, Plesk, fatture, scadenze e rinnovi',
  'facile.webcamgo': 'webcam, stream, snapshot, router, connettività, MikroTik, PTZ, preset, diagnostica, monitoraggio e downtime',
  'facile.sendinitaly': 'utenti, campagne, newsletter, invii, mittenti, piani e statistiche Send in Italy',
  'facile.businesshours': 'orari, aperture e chiusure dei minisiti',
  'facile.asiago': 'eventi, contenuti, articoli, minisiti, bollettino neve, listini e redirect di Asiago.it',
  'facile.webcloud': 'asset WAM, cache Cloudflare, festività, assenze, automazioni e stato operativo del chatbot',
}

const FAST_PATH = /^\s*(?:conferm[oa]?|procedi|esegui|s[iì]|annulla|no|successiv[ei]|precedent[ei]|altr[ei]|apri (?:il |la )?(?:prim[oa]|second[oa]|terz[oa]|\d+))\s*[.!?]?\s*$/i

export function isSemanticFastPath(message = '') {
  return FAST_PATH.test(String(message || ''))
}

function safeHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .slice(-6)
    .map(item => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: String(item?.content || item?.message || item?.reply || '').slice(0, 300),
      moduleId: item?.meta?.moduleId || item?.data?.meta?.moduleId || null,
      resultType: item?.data?.type || null,
    }))
}

function safeContext(context = {}) {
  const entity = context?.activeEntity

  return {
    app: context.app || null,
    section: context.section || null,
    path: context.path || null,
    activeModuleId: context.activeModuleId || context.moduleId || null,
    view: context.view || null,
    activeEntity: entity
      ? {
          type: entity.type || null,
          id: entity.id || null,
          slug: entity.slug || null,
          name: entity.name || null,
        }
      : null,
  }
}

function normalizePlan(raw, availableModuleIds) {
  if (!raw || typeof raw !== 'object') return null

  const mode = ['tool', 'conversation', 'clarification'].includes(raw.mode)
    ? raw.mode
    : null
  const moduleId = Object.hasOwn(MODULES, raw.moduleId) ? raw.moduleId : null
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0))
  const canonicalMessage = String(raw.canonicalMessage || '').trim().slice(0, 1000)
  const secondaryModuleIds = [...new Set(
    (Array.isArray(raw.secondaryModuleIds) ? raw.secondaryModuleIds : [])
      .filter(id => Object.hasOwn(MODULES, id) && id !== moduleId)
  )]

  if (!mode) return null
  if (mode === 'tool' && !moduleId) return null

  return {
    mode,
    moduleId,
    intent: String(raw.intent || '').trim().slice(0, 80) || null,
    canonicalMessage: canonicalMessage || null,
    confidence,
    relationToPrevious: ['new', 'refine', 'correct', 'reference', 'continue'].includes(raw.relationToPrevious)
      ? raw.relationToPrevious
      : 'new',
    entity: raw.entity && typeof raw.entity === 'object'
      ? {
          type: String(raw.entity.type || '').slice(0, 40) || null,
          mention: String(raw.entity.mention || '').trim().slice(0, 200) || null,
        }
      : null,
    secondaryModuleIds,
    available: moduleId ? availableModuleIds.includes(moduleId) : true,
  }
}

export async function planSemanticRequest({message, context = {}, history = [], availableModuleIds = []} = {}, callModel = callOllamaJson) {
  if (!String(message || '').trim() || typeof callModel !== 'function') return null

  const catalog = Object.entries(MODULES)
    .map(([id, description]) => `- ${id}: ${description}`)
    .join('\n')

  const raw = await callModel({
    timeoutMs: Number(process.env.OLLAMA_ROUTER_TIMEOUT_MS || 15000),
    options: {temperature: 0, num_predict: 180},
    messages: [
      {
        role: 'system',
        content: [
          'Planner JSON di Facile. Interpreta l’italiano; non rispondere e non inventare dati o ID.',
          'Output: {"mode":"tool|conversation|clarification","moduleId":string|null,"intent":string,"canonicalMessage":string,"confidence":number,"relationToPrevious":"new|refine|correct|reference|continue","entity":{"type":string|null,"mention":string|null},"secondaryModuleIds":[]}.',
          'Per richieste informative o operative usa tool. canonicalMessage: italiano breve e inequivocabile, stessa azione e TUTTI i vincoli originali.',
          'Risolvi pronomi e follow-up con history e activeEntity, senza creare ID. Un saluto seguito da una richiesta non è conversation.',
          'Per più aree: prima in moduleId, altre in secondaryModuleIds. clarification solo se manca un dato indispensabile.',
          `Moduli disponibili per questa sessione: ${availableModuleIds.join(', ') || 'nessuno'}.`,
          'Catalogo completo:',
          catalog,
          'Esempi: “elenca webcam con stream offline escluse quelle con downtime attivo”; “dettagli della webcam Le Melette”; “elenca servizi del cliente Zilio con piano DomProf in scadenza entro dicembre 2027”.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          message: String(message).slice(0, 1200),
          context: safeContext(context),
          history: safeHistory(history),
        }),
      },
    ],
  })

  return normalizePlan(raw, availableModuleIds)
}

export function getSemanticModuleLabel(moduleId) {
  return MODULES[moduleId] || moduleId
}
