import {callOllamaChat} from '../providers/ollamaProvider.js'

function cleanContent(value, maxLength = 4000) {
  const content = String(value ?? '').trim()
  return content ? content.slice(0, maxLength) : null
}

function normalizeHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .slice(-12)
    .flatMap(item => {
      const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : null
      if (!role) return []

      const content = cleanContent(item?.content ?? item?.message ?? item?.reply)
      return content ? [{role, content}] : []
    })
}

function buildContextHint(context = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null

  const parts = []
  const app = cleanContent(context.app, 120)
  const section = cleanContent(context.section, 160)
  const path = cleanContent(context.path, 300)
  const entity = context.activeEntity && typeof context.activeEntity === 'object'
    ? context.activeEntity
    : null

  if (app) parts.push(`app=${app}`)
  if (section) parts.push(`section=${section}`)
  if (path) parts.push(`path=${path}`)

  if (entity) {
    const type = cleanContent(entity.type || entity.kind, 80)
    const name = cleanContent(entity.name || entity.label || entity.slug || entity.id, 200)
    if (type || name) parts.push(`activeEntity=${[type, name].filter(Boolean).join(':')}`)
  }

  return parts.length ? parts.join(', ') : null
}

export async function executeGlobalConversation({
  message,
  history = [],
  context = {},
  routingSource = 'semantic',
} = {}) {
  const userMessage = cleanContent(message, 8000)
  if (!userMessage) {
    throw Object.assign(new Error('Messaggio mancante'), {statusCode: 400})
  }

  const contextHint = buildContextHint(context)
  const messages = [
    {
      role: 'system',
      content: [
        "Sei l'Assistente AI di Webcloud.",
        "Rispondi normalmente alle richieste dell'utente usando le tue capacità di comprensione, ragionamento, scrittura, programmazione e conoscenza generale.",
        'Non limitarti alle funzioni di Facile: se una richiesta può essere soddisfatta direttamente dal modello, rispondi come un normale assistente AI.',
        'Non fingere però di avere accesso a dati Webcloud, database, servizi esterni o informazioni in tempo reale che non ti sono stati forniti tramite strumenti.',
        'Se una risposta dipende da dati attuali o privati non disponibili, spiega con precisione quale dato o strumento manca invece di inventarlo.',
        'Il contesto dell’interfaccia è solo contesto conversazionale e non costituisce una fonte di dati verificati.',
        'Rispondi nella lingua usata dall’utente e mantieni il filo della conversazione usando la cronologia disponibile.',
        ...(contextHint ? [`Contesto interfaccia corrente: ${contextHint}.`] : []),
      ].join('\n'),
    },
    ...normalizeHistory(history),
    {role: 'user', content: userMessage},
  ]

  const reply = await callOllamaChat({
    messages,
    options: {
      temperature: 0.4,
      num_predict: 800,
    },
  })

  return {
    ok: true,
    intent: 'conversation',
    source: 'llm',
    reply,
    data: {type: 'conversation'},
    meta: {
      moduleId: 'facile',
      orchestrator: 'global-llm',
      routingSource,
    },
  }
}
