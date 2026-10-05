import {parseToolArguments, ToolContractError} from './toolContract.js'

// Provider projection only: business definitions and executors keep their schema.
export function buildAgentToolDefinition(tool) {
  return {
    ...tool.definition,
    function: {
      ...tool.definition.function,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          stateMode: {
            type: 'string', enum: ['refine', 'replace'],
            description: 'refine: continue/correct the SAME stateful query; replace: new query or different tool.',
          },
          args: tool.definition.function.parameters,
        },
        required: ['stateMode', 'args'],
      },
    },
  }
}

export function parseAgentToolArguments(value) {
  const envelope = parseToolArguments(value)
  if (!['refine', 'replace'].includes(envelope.stateMode) ||
      !Object.hasOwn(envelope, 'args') ||
      Object.keys(envelope).some(key => !['stateMode', 'args'].includes(key))) {
    throw new ToolContractError('AGENT_STATE_PROTOCOL_ERROR',
      'Usa {stateMode: "refine" oppure "replace", args: {argomenti di dominio}}.')
  }
  if (typeof envelope.args === 'string') {
    throw new ToolContractError('INVALID_TOOL_ARGUMENTS', 'args deve essere un oggetto, non una stringa JSON annidata.')
  }
  return {stateMode: envelope.stateMode, args: parseToolArguments(envelope.args)}
}

export function mergeToolStateArgs(tool, args, previousState, stateMode) {
  if (stateMode === 'replace') return args
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
export function compactAgentResult(value) {
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
    if (Array.isArray(item)) return item.slice(0, 1).map(child => compact(child, depth + 1)).filter(child => child !== undefined)
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

export function buildAgentState(tool, args, result) {
  return {
    tool: tool.name, moduleId: tool.moduleId,
    args: {...args},
    result: compactAgentResult(result?.modelContent ?? result?.data ?? null),
  }
}
