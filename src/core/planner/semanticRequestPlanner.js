import {callOllamaJson} from '../providers/ollamaProvider.js'

const MODULES = {
  'facile.renewals': 'CRM, clienti, gruppi, servizi, domini, piani, fornitori, Plesk, fatture, scadenze e rinnovi',
  'facile.webcamgo': 'webcam, stream, snapshot, router, connettività, MikroTik, PTZ, preset, diagnostica, monitoraggio e downtime',
  'facile.sendinitaly':
    'utenti, campagne, newsletter, invii, mittenti, piani, statistiche e ticket assistenza Send in Italy',
  'facile.businesshours': 'orari, aperture e chiusure dei minisiti',
  'facile.asiago': 'eventi, contenuti, articoli, minisiti, bollettino neve, listini e redirect di Asiago.it',
  'facile.webcloud': 'asset WAM, cache Cloudflare, festività, assenze, automazioni e stato operativo del chatbot',
}

const MODULE_LABELS = {
  'facile.renewals': 'Rinnovi e CRM',
  'facile.webcamgo': 'WebcamGo',
  'facile.sendinitaly': 'Assistenza e Send in Italy',
  'facile.businesshours': 'Orari minisiti',
  'facile.asiago': 'Asiago.it e CMS',
  'facile.webcloud': 'Strumenti Webcloud',
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
  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : []
  const tasks = rawTasks
    .map(task => {
      const taskModuleId = Object.hasOwn(MODULES, task?.moduleId) ? task.moduleId : null
      const taskMessage = String(task?.canonicalMessage || '').trim().slice(0, 1000)
      const operation = ['read', 'write'].includes(task?.operation) ? task.operation : 'unknown'
      return taskModuleId && taskMessage
        ? {moduleId: taskModuleId, canonicalMessage: taskMessage, operation}
        : null
    })
    .filter(Boolean)
    .filter((task, index, all) => all.findIndex(item => item.moduleId === task.moduleId) === index)
    .slice(0, 4)
  const taskModuleIds = tasks.map(task => task.moduleId)
  const resolvedModuleId = taskModuleIds[0] || moduleId
  const secondaryModuleIds = [...new Set(
    (Array.isArray(raw.secondaryModuleIds) ? raw.secondaryModuleIds : [])
      .filter(id => Object.hasOwn(MODULES, id) && id !== resolvedModuleId)
  )]
  for (const taskModuleId of taskModuleIds.slice(1)) {
    if (!secondaryModuleIds.includes(taskModuleId)) secondaryModuleIds.push(taskModuleId)
  }

  if (!mode) return null
  if (mode === 'tool' && !resolvedModuleId) return null

  return {
    mode,
    moduleId: resolvedModuleId,
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
    tasks,
    available:
      resolvedModuleId
        ? [resolvedModuleId, ...secondaryModuleIds].every(id => availableModuleIds.includes(id))
        : true,
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
          'Output: {"mode":"tool|conversation|clarification","moduleId":string|null,"intent":string,"canonicalMessage":string,"confidence":number,"relationToPrevious":"new|refine|correct|reference|continue","entity":{"type":string|null,"mention":string|null},"secondaryModuleIds":[],"tasks":[{"moduleId":string,"canonicalMessage":string,"operation":"read|write"}]}.',
          'Usa mode=tool SOLO quando per soddisfare la richiesta servono dati, stato o operazioni delle applicazioni Webcloud elencate nel catalogo.',
          'Usa mode=conversation quando il modello può rispondere direttamente: conversazione generale, conoscenza generale, spiegazioni tecniche, scrittura o riscrittura, brainstorming, programmazione e analisi che non richiedono dati Webcloud.',
          'Non scegliere un modulo soltanto perché nel messaggio compare una parola presente nella sua descrizione. Chiediti se per rispondere servono davvero dati o azioni di quel modulo.',
          'Se la richiesta riguarda informazioni attuali esterne non coperte dai moduli disponibili, usa conversation: sarà la risposta conversazionale a dichiarare l’eventuale mancanza di dati realtime.',
          'Per mode=tool, canonicalMessage deve essere italiano breve e inequivocabile e deve conservare la stessa azione e TUTTI i vincoli originali.',
          'Se una richiesta tool contiene più obiettivi in aree diverse, crea un task autonomo per ogni area, con la sola parte pertinente. Usa operation=write se modifica dati, invia messaggi o controlla dispositivi; altrimenti read.',
          'Risolvi pronomi e follow-up con history e activeEntity, senza creare ID. Un saluto da solo o seguito da una richiesta generale è conversation; un saluto seguito da una richiesta che necessita dati Webcloud è tool.',
          'Per più aree tool: prima in moduleId, altre in secondaryModuleIds. clarification solo se manca un dato indispensabile.',
          `Moduli disponibili per questa sessione: ${availableModuleIds.join(', ') || 'nessuno'}.`,
          'Catalogo completo:',
          catalog,
          'Esempi conversation: “cos’è un record MX?”, “spiegami come funziona Plesk”, “scrivimi una mail di sollecito”, “perché nginx può restituire 502?”, “che tempo fa oggi?” se non esiste un tool meteo disponibile.',
          'Esempi tool: “elenca webcam con stream offline escluse quelle con downtime attivo”; “dettagli della webcam Le Melette”; “elenca servizi del cliente Zilio con piano DomProf in scadenza entro dicembre 2027”. Per “quante webcam sono offline e quanti ticket sono da gestire” genera due task read, uno WebcamGo e uno Send in Italy.',
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
  return MODULE_LABELS[moduleId] || moduleId
}
