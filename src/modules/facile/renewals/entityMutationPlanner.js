import {callOllamaChat} from '../../../core/providers/ollamaProvider.js'
import {
  buildEntityMutationCapabilities,
  findEntityMutationDefinitionByAlias,
  findEntityMutationField,
  validateEntityMutationPlan,
} from './entityMutationRegistry.js'

const MUTATION_VERB_PATTERN =
  /\b(?:rinomina|rinominare|imposta|impostare|cambia|cambiare|modifica|modificare|aggiorna|aggiornare|assegna|assegnare|sostituisci|sostituire|porta|portare|rimuovi|rimuovere|togli|togliere|azzera|azzerare|fai|rendi)\b/i

function normalizeText(value = '') {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanValue(value = '') {
  return String(value || '')
    .replace(/[?.!,;:]+$/g, '')
    .replace(/^[\s:'"“”,-]+|[\s:'"“”,-]+$/g, '')
    .trim()
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

function detectEntityInText(text = '') {
  return findEntityMutationDefinitionByAlias(text)
}

function stripEntityPrefix(value = '', definition = null) {
  let text = cleanValue(value)
  if (!definition) return text

  const aliases = [definition.singular, ...(definition.aliases || [])]
    .filter(Boolean)
    .sort((first, second) => second.length - first.length)

  for (const alias of aliases) {
    const pattern = new RegExp(
      `^(?:(?:il|lo|la|i|gli|le|un|una)\\s+)?${String(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`,
      'i'
    )

    if (pattern.test(text)) {
      text = cleanValue(text.replace(pattern, ''))
      break
    }
  }

  return text
}

function parseRename(message = '') {
  const match = String(message || '').match(
    /^\s*(?:rinomina|rinominare|cambia\s+nome\s+(?:a|di)|modifica\s+il\s+nome\s+(?:a|di))\s+(.+?)\s+(?:in|come|a)\s+(.+?)\s*$/i
  )

  if (!match?.[1] || !match?.[2]) return null

  const entity = detectEntityInText(match[1])
  if (!entity) return null

  const target = stripEntityPrefix(match[1], entity)
  const value = cleanValue(match[2])

  if (!target || !value) return null

  return {
    operation: 'update',
    entity: entity.id,
    target,
    changes: [{field: 'name', value}],
    source: 'deterministic',
    confidence: 1,
    sourceMessage: message,
  }
}

function parseSetField(message = '') {
  const source = String(message || '').trim()
  const patterns = [
    /^(?:imposta|cambia|modifica|aggiorna|assegna|sostituisci|porta)\s+(?:il|lo|la|l['’])?\s*(.+?)\s+(?:(?:del|della|dello|di)\s+|dell['’]\s*)(.+?)\s+(?:a|in|con|su)\s+(.+?)\s*$/i,
    /^(?:imposta|cambia|modifica|aggiorna)\s+(.+?)\s+(?:con|avendo|:)\s*(.+?)\s+(?:a|in|su|=)\s*(.+?)\s*$/i,
  ]

  for (const pattern of patterns) {
    const match = source.match(pattern)
    if (!match) continue

    const first = cleanValue(match[1])
    const second = cleanValue(match[2])
    const rawValue = cleanValue(match[3])

    const entity = detectEntityInText(second) || detectEntityInText(first)
    if (!entity) continue

    const fieldCandidate = detectEntityInText(second)
      ? findEntityMutationField(entity, first)
      : findEntityMutationField(entity, second)

    if (!fieldCandidate) continue

    const targetSource = detectEntityInText(second) ? second : first
    const target = stripEntityPrefix(targetSource, entity)

    if (!target) continue

    return {
      operation: 'update',
      entity: entity.id,
      target,
      changes: [{field: fieldCandidate.id, value: rawValue}],
      source: 'deterministic',
      confidence: 1,
      sourceMessage: message,
    }
  }

  return null
}

function parseRelationAssignment(message = '') {
  const match = String(message || '').match(
    /^\s*(?:assegna|sposta|collega|associa)\s+(?:il|lo|la|l['’])?\s*(.+?)\s+(?:al|alla|allo|all['’]|a)\s+(.+?)\s*$/i
  )

  if (!match?.[1] || !match?.[2]) return null

  const targetEntity = detectEntityInText(match[1])
  const relationEntity = detectEntityInText(match[2])
  if (!targetEntity || !relationEntity) return null

  const relationField = [...targetEntity.fields.entries()]
    .map(([id, item]) => ({id, ...item}))
    .find(item => item.type === 'relation' && item.relationEntity === relationEntity.id)

  if (!relationField) return null

  const target = stripEntityPrefix(match[1], targetEntity)
  const value = stripEntityPrefix(match[2], relationEntity)
  if (!target || !value) return null

  return {
    operation: 'update',
    entity: targetEntity.id,
    target,
    changes: [{field: relationField.id, value}],
    source: 'deterministic',
    confidence: 1,
    sourceMessage: message,
  }
}

function parsePlanPrice(message = '') {
  const match = String(message || '').match(
    /^\s*(?:imposta|cambia|modifica|aggiorna)\s+(?:il|lo|la|l['’])?\s*(?:prezzo|costo|tariffa)\s+(?:del|della|di)\s+piano\s+(.+?)(?:\s+(?:nel|per il|sul)\s+listino\s+(.+?))?\s+(?:a|in)\s+(.+?)\s*$/i
  )

  if (!match?.[1] || !match?.[3]) return null

  const target = cleanValue(
    match[2] ? `${cleanValue(match[1])} · ${cleanValue(match[2])}` : match[1]
  )

  return {
    operation: 'update',
    entity: 'plan-prices',
    target,
    changes: [{field: 'price', value: cleanValue(match[3])}],
    source: 'deterministic',
    confidence: 1,
    sourceMessage: message,
  }
}

function parseClearField(message = '') {
  const match = String(message || '').match(
    /^\s*(?:rimuovi|togli|azzera|cancella)\s+(?:il|lo|la|l['’])?\s*(.+?)\s+(?:del|della|dell['’]|dello|di)\s+(.+?)\s*$/i
  )

  if (!match?.[1] || !match?.[2]) return null

  const entity = detectEntityInText(match[2])
  if (!entity) return null

  const fieldCandidate = findEntityMutationField(entity, match[1])
  if (!fieldCandidate?.nullable) return null

  const target = stripEntityPrefix(match[2], entity)
  if (!target) return null

  return {
    operation: 'update',
    entity: entity.id,
    target,
    changes: [{field: fieldCandidate.id, value: null}],
    source: 'deterministic',
    confidence: 1,
    sourceMessage: message,
  }
}

export function parseEntityMutationRequest(message = '') {
  const text = String(message || '').trim()
  if (!text || !MUTATION_VERB_PATTERN.test(text)) return null

  const rawPlan =
    parseRename(text) ||
    parseRelationAssignment(text) ||
    parsePlanPrice(text) ||
    parseClearField(text) ||
    parseSetField(text)
  if (!rawPlan) return null

  const validation = validateEntityMutationPlan(rawPlan)
  return validation.ok ? validation.plan : null
}

export function shouldPlanEntityMutation(message = '') {
  const text = normalizeText(message)
  return Boolean(text && MUTATION_VERB_PATTERN.test(text))
}

export async function planEntityMutationRequest({
  message = '',
  history = [],
  callLlm = callOllamaChat,
  timeoutMs = 7000,
} = {}) {
  const deterministic = parseEntityMutationRequest(message)
  if (deterministic) return deterministic
  if (!shouldPlanEntityMutation(message)) return null

  const capabilities = buildEntityMutationCapabilities()
  const systemPrompt = [
    'Sei il planner delle modifiche anagrafiche del modulo rinnovi Webcloud.',
    'Non rispondere all’utente e non eseguire modifiche.',
    'Produci soltanto un piano astratto JSON usando esclusivamente entità e campi autorizzati.',
    'Non usare nomi di collezioni Directus, SQL, endpoint o campi tecnici.',
    'L’operazione consentita è soltanto update.',
    'Il target deve contenere il nome concreto dell’elemento da modificare.',
    'Per i campi relation restituisci nel value il nome indicato dall’utente, non un ID inventato.',
    'Per rimuovere un valore nullable usa null.',
    'Se la richiesta non è una modifica anagrafica valida restituisci {"operation":"unknown"}.',
    'Restituisci esclusivamente JSON valido senza markdown.',
  ].join(' ')

  const recentConversation = (Array.isArray(history) ? history : [])
    .slice(-6)
    .map(item => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: String(item?.content || item?.message || '').trim(),
    }))
    .filter(item => item.content)

  const raw = await callLlm({
    timeoutMs,
    messages: [
      {role: 'system', content: systemPrompt},
      {
        role: 'user',
        content: JSON.stringify({
          request: String(message || '').trim(),
          recentConversation,
          capabilities,
          outputSchema: {
            operation: 'update | unknown',
            entity: 'authorized entity id',
            target: 'string',
            changes: [{field: 'authorized field id', value: 'scalar, string or null'}],
            confidence: 'number between 0 and 1',
          },
        }),
      },
    ],
  })

  const parsed = extractJsonObject(raw)
  if (parsed?.operation !== 'update') return null

  const validation = validateEntityMutationPlan({
    ...parsed,
    source: 'semantic',
    sourceMessage: message,
  })

  if (!validation.ok || validation.plan.confidence < 0.75) return null
  return validation.plan
}
