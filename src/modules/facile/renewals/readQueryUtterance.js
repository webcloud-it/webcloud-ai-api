import {callOllamaChat} from '../../../core/providers/ollamaProvider.js'
import {
  findReadEntityByAlias,
  getReadEntityDefinitions,
  getReadEntityRegistry,
} from './readEntityRegistry.js'

const ALLOWED_OPERATIONS = new Set(['detail', 'list', 'count', 'unknown'])
const CONTEXT_TARGETS = new Set([
  'questo',
  'questa',
  'quello',
  'quella',
  'questi',
  'queste',
  'quelli',
  'quelle',
  'lo stesso',
  'la stessa',
  'il primo',
  'la prima',
  'il secondo',
  'la seconda',
  'il terzo',
  'la terza',
  'l ultimo',
  "l'ultimo",
  'ultimo',
  'ultima',
])

const MUTATION_PATTERN =
  /\b(?:segna|segnala|marca|imposta|attiva|abilita|aggiungi|metti|sposta|assegna|rimuovi|togli|disattiva|disabilita|elimina|cancella|revoca|azzera|resetta|modifica|cambia|aggiorna|proroga|posticipa|anticipa|copia|allinea|sincronizza|salva|inserisci|registra|sostituisci|rinnova|trasferisci|esegui|conferma|annulla|undo|revert)\b/i

const PAGINATION_PATTERN =
  /^(?:e\s+)?(?:altri|altre|prossimi|prossime|successivi|successive|seguenti|ancora|continua|prosegui|vai avanti|avanti|indietro|precedenti|precedente|pagina precedente|torna all['’]inizio|ai primi|alle prime)(?:\s+\d{1,2})?[?.!]*$/i

const DETAIL_PATTERNS = [
  /^(?:dammi|mostrami|fammi\s+vedere|forniscimi|recupera|apri)?\s*(?:i\s+)?(?:dettagli|dettaglio|scheda|informazioni|info|dati|descrizione)(?:\s+(?:dell['’]|sull['’]|della|dello|degli|delle|sulla|sullo|del|sul|di|su))?\s+(.+)$/i,
  /^(?:parlami|raccontami|spiegami|descrivimi|illustrami|presentami)(?:\s+(?:qualcosa|un\s+po['’]?|meglio))?\s+(?:dell['’]|sull['’]|della|dello|degli|delle|sulla|sullo|del|sul|di|su)\s+(.+)$/i,
  /^(?:parlami|raccontami|spiegami|descrivimi|illustrami|presentami)(?:\s+(?:qualcosa|un\s+po['’]?|meglio))?\s+(?:il|lo|la|l['’]|i|gli|le)\s*(.+)$/i,
  /^(?:che|cosa|che\s+cosa)\s+(?:mi\s+)?(?:dici|sai|puoi\s+dirmi|puoi\s+raccontarmi)\s+(?:dell['’]|sull['’]|della|dello|del|sul|di|su)\s+(.+)$/i,
  /^(?:vorrei|voglio|mi\s+piacerebbe)\s+(?:sapere|conoscere|avere\s+informazioni|saperne\s+di\s+pi[uù])(?:\s+(?:qualcosa|di\s+pi[uù]))?\s+(?:dell['’]|sull['’]|della|dello|del|sul|di|su)\s+(.+)$/i,
  /^(?:mi\s+)?(?:dai|daresti|fornisci|forniresti)\s+(?:qualche\s+)?(?:informazione|informazioni|dettaglio|dettagli)\s+(?:dell['’]|sull['’]|della|dello|del|sul|di|su)\s+(.+)$/i,
  /^(?:cosa|che\s+cosa)\s+sai\s+(?:dell['’]|sull['’]|della|dello|del|sul|di|su)\s+(.+)$/i,
  /^(?:cos['’]?[eè]|che\s+cos['’]?[eè]|chi\s+[eè])\s+(.+)$/i,
  /^(.+?)\s*[:,]?\s*(?:cosa\s+offre|che\s+cos['’]?[eè]|chi\s+[eè]|di\s+cosa\s+si\s+tratta)\??$/i,
]

function normalizeText(value = '') {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanTarget(value = '') {
  return String(value || '')
    .replace(/[?.!,;:]+$/g, '')
    .replace(/^[\s:'"“”,-]+|[\s:'"“”,-]+$/g, '')
    .trim()
}

function normalizeConfidence(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(1, number))
}

function normalizeEntityHint(value = '') {
  const raw = String(value || '').trim()
  if (!raw) return null

  const registry = getReadEntityRegistry()
  if (registry.has(raw)) return raw

  return findReadEntityByAlias(raw)?.id || null
}

function stripEntityHint(target = '') {
  const cleaned = cleanTarget(target)
  if (!cleaned) return {target: null, entityHint: null}

  const definitions = getReadEntityDefinitions()
    .map(definition => getReadEntityRegistry().get(definition.id))
    .filter(Boolean)

  const aliases = definitions
    .flatMap(definition =>
      [definition.singular, definition.label, ...(definition.aliases || [])]
        .filter(Boolean)
        .map(alias => ({definition, alias: String(alias)}))
    )
    .sort((first, second) => second.alias.length - first.alias.length)

  for (const {definition, alias} of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(
      `^(?:(?:il|lo|la|i|gli|le|un|una)\\s+)?${escaped}(?:\\s+|$)`,
      'i'
    )

    if (!pattern.test(cleaned)) continue

    const stripped = cleanTarget(cleaned.replace(pattern, ''))
    if (!stripped) break

    return {
      target: stripped,
      entityHint: definition.id,
    }
  }

  return {target: cleaned, entityHint: null}
}

function getQuotedTarget(message = '') {
  const match = String(message || '').match(/["“”']([^"“”']{2,})["“”']/)
  return cleanTarget(match?.[1]) || null
}

export function parseReadQueryUtterance(message = '') {
  const raw = String(message || '').trim()
  const text = normalizeText(raw)

  if (!text || MUTATION_PATTERN.test(text) || PAGINATION_PATTERN.test(text)) {
    return null
  }

  const quotedTarget = getQuotedTarget(raw)

  for (const pattern of DETAIL_PATTERNS) {
    const match = raw.match(pattern)
    const rawTarget = quotedTarget || cleanTarget(match?.[1])
    if (!rawTarget) continue

    const {target, entityHint} = stripEntityHint(rawTarget)
    if (!target) continue

    return {
      type: 'read-query-utterance',
      operation: 'detail',
      target,
      entityHint,
      contextual: CONTEXT_TARGETS.has(normalizeText(target)),
      confidence: 1,
      source: 'deterministic-utterance',
      sourceMessage: raw,
    }
  }

  return null
}

function looksLikePotentialReadRequest(message = '') {
  const raw = String(message || '').trim()
  const text = normalizeText(raw)

  if (!text || text.length > 500) return false
  if (MUTATION_PATTERN.test(text) || PAGINATION_PATTERN.test(text)) return false

  if (getQuotedTarget(raw)) return true
  if (/\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{2,})+\b/i.test(raw)) {
    return true
  }

  if (
    /^(?:parlami|raccontami|spiegami|descrivimi|illustrami|presentami|dimmi|mostrami|fammi|vorrei|voglio|mi\s+piacerebbe|che\s+mi\s+dici|cosa\s+sai|che\s+cosa\s+sai|cos['’]?[eè]|chi\s+[eè])\b/i.test(
      text
    )
  ) {
    return true
  }

  return Boolean(findReadEntityByAlias(text))
}

function extractJsonObject(value = '') {
  const text = String(value || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  try {
    return JSON.parse(text)
  } catch {}

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

function getHistoryText(item = {}) {
  const content = item?.content
  if (typeof content === 'string') return content.trim()
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text.trim()
  }
  return ''
}

function buildRecentConversation(history = []) {
  return (Array.isArray(history) ? history : [])
    .slice(-4)
    .map(item => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: getHistoryText(item),
    }))
    .filter(item => item.content)
}

async function parseSemanticReadQueryUtterance({message = '', history = [], callLlm}) {
  const definitions = getReadEntityDefinitions().map(definition => ({
    id: definition.id,
    label: definition.label,
    singular: definition.singular,
    aliases: definition.aliases,
  }))

  const systemPrompt = [
    'Sei l’interprete delle richieste di sola lettura del modulo rinnovi Webcloud.',
    'Non rispondere all’utente e non accedere a database, Directus o API.',
    'Devi soltanto capire se l’utente sta chiedendo informazioni o dettagli su un soggetto.',
    'Le action, i rinnovi, le modifiche, le conferme, gli annullamenti e la paginazione sono gestiti altrove.',
    'Per una richiesta come “parlami di X”, “che mi dici di X”, “vorrei sapere qualcosa su X” o una parafrasi equivalente usa operation=detail e conserva X esattamente come target.',
    'entityHint deve essere uno degli id consentiti solo quando il tipo di entità è esplicito; altrimenti null.',
    'Non inventare il tipo di entità dal nome del target.',
    'Se non è chiaramente una richiesta di lettura usa operation=unknown.',
    'Restituisci esclusivamente JSON valido senza markdown.',
  ].join(' ')

  const payload = {
    request: String(message || '').trim(),
    recentConversation: buildRecentConversation(history),
    entities: definitions,
    outputSchema: {
      operation: 'detail | unknown',
      target: 'string or null',
      entityHint: 'allowed entity id or null',
      contextual: 'boolean',
      confidence: 'number between 0 and 1',
    },
  }

  const raw = await callLlm({
    timeoutMs: 5000,
    messages: [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: JSON.stringify(payload)},
    ],
  })

  const parsed = extractJsonObject(raw)
  const operation = String(parsed?.operation || '').trim()
  const confidence = normalizeConfidence(parsed?.confidence)

  if (!ALLOWED_OPERATIONS.has(operation) || operation !== 'detail' || confidence < 0.75) {
    return null
  }

  const target = cleanTarget(parsed?.target)
  if (!target || target.length > 300) return null

  return {
    type: 'read-query-utterance',
    operation: 'detail',
    target,
    entityHint: normalizeEntityHint(parsed?.entityHint),
    contextual:
      parsed?.contextual === true || CONTEXT_TARGETS.has(normalizeText(target)),
    confidence,
    source: 'semantic-utterance',
    sourceMessage: String(message || '').trim(),
  }
}

export async function interpretReadQueryUtterance({
  message = '',
  history = [],
  callLlm = callOllamaChat,
  allowSemantic = true,
} = {}) {
  const deterministic = parseReadQueryUtterance(message)
  if (deterministic) return deterministic

  if (!allowSemantic || !looksLikePotentialReadRequest(message)) return null

  try {
    return await parseSemanticReadQueryUtterance({message, history, callLlm})
  } catch {
    return null
  }
}
