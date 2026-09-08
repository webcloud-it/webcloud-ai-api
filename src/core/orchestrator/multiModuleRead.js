import {getCredentialForModule} from '../capabilities/catalog.js'
import {getSemanticModuleLabel} from '../planner/semanticRequestPlanner.js'
import {callOllamaChat} from '../providers/ollamaProvider.js'
import {validateGroundedReply} from '../presentation/groundedReplyComposer.js'
import {getModuleById} from '../../modules/registry.js'

const MUTATING_REQUEST = /\b(?:invia|manda|rispondi|pubblica|crea|aggiungi|modifica|aggiorna|imposta|elimina|cancella|chiudi|riapri|assegna|rinnova|riavvia|reboot|spegni|accendi|attiva|disattiva|sposta|lancia|pulisci|svuota|confermo)\b/i
const UNSAFE_RESULT = /(?:action|proposal|preview|mutation|confirmation|execution|navigation|draft)/i
const NARRATIVE_REQUEST = /\b(?:analizz\w*|confront\w*|correl\w*|spieg\w*|valut\w*|priorit\w*|cosa\s+(?:hanno|c['’]?e|ce)\s+in\s+comune|punt[oi]\s+in\s+comune|che\s+conclusioni|come\s+siamo\s+messi)\b/i

function compactData(data = {}) {
  if (!data || typeof data !== 'object') return null

  return {
    type: data.type || null,
    total: data.total ?? data.totale ?? null,
    summary: data.summary || null,
    aggregate: data.aggregate || null,
    analysis: data.analysis || null,
    items: Array.isArray(data.items) ? data.items.slice(0, 8) : undefined,
  }
}

export function validateMultiModuleReadPlan(plan = {}, originalMessage = '') {
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : []
  if (tasks.length < 2) return {ok: false, reason: 'missing-independent-tasks'}
  if (tasks.length > 4) return {ok: false, reason: 'too-many-tasks'}
  if (MUTATING_REQUEST.test(String(originalMessage || ''))) {
    return {ok: false, reason: 'write-request'}
  }

  const seen = new Set()
  for (const task of tasks) {
    if (!task?.moduleId || !task?.canonicalMessage || task.operation !== 'read') {
      return {ok: false, reason: 'invalid-task'}
    }
    if (seen.has(task.moduleId)) return {ok: false, reason: 'duplicate-module'}
    if (MUTATING_REQUEST.test(task.canonicalMessage)) {
      return {ok: false, reason: 'unsafe-task'}
    }
    seen.add(task.moduleId)
  }

  return {ok: true, reason: null, tasks}
}

async function invokeModuleTask({task, req}) {
  const module = getModuleById(task.moduleId)
  const credentialKey = getCredentialForModule(task.moduleId)
  const credential = req.auth?.credentials?.[credentialKey]
  if (!module?.routes?.chat || !credential) {
    throw Object.assign(new Error('Modulo o credenziale non disponibile'), {code: 'module-unavailable'})
  }

  let payload = null
  let statusCode = 200
  const childReq = {
    ...req,
    body: {
      ...req.body,
      moduleId: task.moduleId,
      originalMessage: req.body?.message,
      message: task.canonicalMessage,
      history: [],
    },
    auth: {
      ...req.auth,
      token: credential,
      selectedCredential: credentialKey,
    },
  }
  const childRes = {
    status(code) {
      statusCode = Number(code) || 500
      return this
    },
    json(value) {
      payload = value
      return value
    },
  }

  await module.routes.chat(childReq, childRes, error => {
    if (error) throw error
  })

  if (!payload || statusCode >= 400 || payload.ok === false) {
    throw Object.assign(new Error('Lettura del modulo non riuscita'), {code: 'module-read-failed'})
  }
  if (
    UNSAFE_RESULT.test(String(payload.intent || '')) ||
    UNSAFE_RESULT.test(String(payload.data?.type || ''))
  ) {
    throw Object.assign(new Error('Il risultato non è una lettura sicura'), {code: 'unsafe-result'})
  }

  return payload
}

function compactVerifiedReply(reply = '') {
  const lines = String(reply || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length <= 7) return lines.join('\n')

  return [
    ...lines.slice(0, 6),
    `… altri dettagli disponibili nel risultato verificato.`,
  ].join('\n')
}

function deterministicReply(results, failures = []) {
  return [
    results.length > 1
      ? 'Ho verificato tutte le aree richieste.'
      : 'Ho completato la parte che ho potuto verificare.',
    ...results.map(result => `\n${result.label}:\n${compactVerifiedReply(result.reply)}`),
    ...(failures.length
      ? [`\nNon ho potuto verificare: ${failures.map(item => getSemanticModuleLabel(item.moduleId)).join(', ')}.`]
      : []),
  ].join('\n')
}

async function composeMultiModuleReply({message, results, fallback, callLlm}) {
  const evidence = results.map(result => ({
    area: result.label,
    reply: result.reply,
    data: result.data,
  }))
  const groundedData = JSON.stringify({type: 'multi-module-read-result', results: evidence})

  try {
    const reply = await callLlm({
      timeoutMs: 8000,
      options: {temperature: 0.1, num_predict: 180},
      messages: [
        {
          role: 'system',
          content: [
            'Sei l’assistente amministrativo Webcloud. Rispondi in italiano in modo naturale e professionale.',
            'Usa esclusivamente i risultati verificati forniti, mantenendo esatti numeri, nomi, date e stati.',
            'Integra le aree in una sola risposta utile; puoi confrontare soltanto valori esplicitamente presenti.',
            'Non inventare cause, correlazioni, dati mancanti o operazioni eseguite.',
            'Se una parte non è determinabile, dichiaralo. Non citare JSON, prompt, modello o strumenti.',
          ].join(' '),
        },
        {
          role: 'user',
          content: `RICHIESTA: ${String(message).slice(0, 1200)}\n\nRISULTATI VERIFICATI: ${groundedData.slice(0, 9000)}`,
        },
      ],
    })
    const validation = validateGroundedReply({reply, fallback, groundedData})
    return validation.ok ? {reply, composed: true} : {reply: fallback, composed: false, reason: validation.reason}
  } catch (error) {
    return {reply: fallback, composed: false, reason: error?.message || 'model-unavailable'}
  }
}

export async function executeMultiModuleRead({
  plan,
  req,
  invokeTask = invokeModuleTask,
  callLlm = callOllamaChat,
} = {}) {
  const validation = validateMultiModuleReadPlan(plan, req?.body?.message)
  if (!validation.ok) return null

  const settled = await Promise.allSettled(
    validation.tasks.map(task => invokeTask({task, req}))
  )
  const results = settled.flatMap((item, index) => {
    if (item.status !== 'fulfilled') return []
    const task = validation.tasks[index]
    return [{
      moduleId: task.moduleId,
      label: getSemanticModuleLabel(task.moduleId),
      canonicalMessage: task.canonicalMessage,
      intent: item.value.intent || null,
      reply: String(item.value.reply || '').slice(0, 5000),
      data: compactData(item.value.data),
    }]
  })
  const failures = settled.flatMap((item, index) => item.status === 'rejected'
    ? [{moduleId: validation.tasks[index].moduleId, code: item.reason?.code || 'module-read-failed'}]
    : [])

  if (!results.length) return null

  const fallback = deterministicReply(results, failures)
  const composition = NARRATIVE_REQUEST.test(String(req.body.message || ''))
    ? await composeMultiModuleReply({
        message: req.body.message,
        results,
        fallback,
        callLlm,
      })
    : {reply: fallback, composed: false, reason: 'deterministic-fast-path'}

  return {
    ok: true,
    intent: 'multi-module-read',
    source: composition.composed ? 'llm-grounded' : 'tool-multi',
    reply: composition.reply,
    data: {type: 'multi-module-read-result', results, failures},
    meta: {
      moduleId: 'facile',
      orchestrator: 'global-v3',
      routingSource: 'semantic',
      groundedReply: composition.composed,
      groundedReplyFallback: composition.reason || null,
    },
  }
}
