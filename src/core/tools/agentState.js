import {parseToolArguments, ToolContractError, validateToolArguments} from './toolContract.js'

export const AGENT_STATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    stateMode: {type: 'string', enum: ['refine', 'replace', 'switch']},
    entityReference: {type: 'string', description: 'Nome dell’entità precedente SOLO se il turno corrente vi fa riferimento; altrimenti stringa vuota.'},
  },
  required: ['stateMode', 'entityReference'],
}

export function parseAgentStateDecision(content) {
  try {
    const decision = parseToolArguments(content)
    validateToolArguments({definition: {function: {parameters: AGENT_STATE_SCHEMA}}}, decision)
    if (decision.entityReference.length > 200) throw new Error('Riferimento entità troppo lungo')
    return decision
  } catch (_) {
    throw new ToolContractError('AGENT_STATE_PROTOCOL_ERROR', 'Decisione di stato non valida: richiesti stateMode refine/replace/switch ed entityReference stringa.')
  }
}

export function mergeToolStateArgs(tool, args, previousState, stateMode) {
  if (stateMode === 'replace' || stateMode === 'switch') return args
  if (!previousState || typeof previousState.tool !== 'string' ||
      !previousState.args || typeof previousState.args !== 'object' || Array.isArray(previousState.args)) {
    throw new ToolContractError('AGENT_STATE_INVALID', 'Non esiste uno stato di query utilizzabile per refine. Usa replace per una nuova query.')
  }
  // A tool switch never inherits the other tool's domain arguments.
  if (previousState.tool !== tool.name || tool.stateful !== true) return args
  if (previousState.moduleId && previousState.moduleId !== tool.moduleId) {
    throw new ToolContractError('AGENT_STATE_INVALID', 'Il modulo dello stato precedente non corrisponde al tool.')
  }
  return {...previousState.args, ...args}
}

// The model gets a small result sample, not the entire table from client history.
// Snapshots originate in a successful executor; echoed client snapshots are untrusted.
export function compactAgentResult(value, {arrayLimit = 1} = {}) {
  let budget = 100
  let characters = 1800
  function compact(item, depth = 0) {
    if (--budget < 0 || depth > 4 || characters <= 0) return undefined
    if (item === undefined) return undefined
    if (typeof item === 'string') {
      const text = item.slice(0, Math.min(120, characters))
      characters -= text.length + 2
      return text
    }
    if (item == null || typeof item === 'boolean' || typeof item === 'number') {
      characters -= JSON.stringify(item).length
      return item
    }
    if (Array.isArray(item)) return item.slice(0, arrayLimit).map(child => compact(child, depth + 1)).filter(child => child !== undefined)
    if (typeof item !== 'object') return undefined
    return Object.fromEntries(Object.entries(item).slice(0, 20)
      .map(([key, child]) => {
        const name = key.slice(0, 80)
        characters -= name.length + 4
        return [name, compact(child, depth + 1)]
      })
      .filter(([, child]) => child !== undefined))
  }
  return compact(value)
}

export function summarizeAgentResult(value) {
  if (value && typeof value === 'object' && Array.isArray(value.items)) {
    const singleton = value.shown === 1 || (value.shown == null && value.items.length === 1)
    if (!singleton) {
      // A sampled row from a table is not the entity referred to by the query.
      const {items, ...metadata} = value
      return compactAgentResult(metadata)
    }
  }
  return compactAgentResult(value)
}

export function buildAgentState(tool, args, result) {
  return {
    tool: tool.name, moduleId: tool.moduleId,
    stateful: tool.stateful === true,
    args: {...args},
    result: summarizeAgentResult(result?.modelContent ?? result?.data ?? null),
  }
}
