import {isDeepStrictEqual} from 'node:util'
import {getCapabilityCatalog} from '../capabilities/catalog.js'

const SCHEMA_KEYS = new Set([
  'type', 'description', 'enum', 'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'minimum', 'maximum',
])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'])
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export class ToolContractError extends Error {
  constructor(code, message, issues = []) {
    super(message)
    this.name = 'ToolContractError'
    this.code = code
    this.issues = issues
  }
}

// A deliberately bounded JSON Schema subset. Unsupported constraints fail at
// registration instead of silently weakening the definition's contract.
export function assertToolSchema(schema, path = '$') {
  const fail = detail => { throw new TypeError(`Schema tool non valido (${path}): ${detail}`) }
  if (!isObject(schema) || !SCHEMA_TYPES.has(schema.type)) fail('type mancante o non supportato')
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.has(key)) fail(`keyword non supportata: ${key}`)
  }
  if (Object.hasOwn(schema, 'description') && typeof schema.description !== 'string') fail('description non stringa')
  if (Object.hasOwn(schema, 'enum') && (!Array.isArray(schema.enum) || !schema.enum.length)) fail('enum non valido')

  for (const key of ['minimum', 'maximum']) {
    if (!Object.hasOwn(schema, key)) continue
    if (!['number', 'integer'].includes(schema.type) || !Number.isFinite(schema[key])) fail(`${key} non valido`)
  }
  if (schema.minimum > schema.maximum) fail('minimum maggiore di maximum')

  for (const key of ['minItems', 'maxItems']) {
    if (!Object.hasOwn(schema, key)) continue
    if (schema.type !== 'array' || !Number.isInteger(schema[key]) || schema[key] < 0) fail(`${key} non valido`)
  }
  if (schema.minItems > schema.maxItems) fail('minItems maggiore di maxItems')
  if (Object.hasOwn(schema, 'items') && schema.type !== 'array') fail('items richiede type array')
  if (schema.type === 'array') {
    if (!Object.hasOwn(schema, 'items')) fail('items mancante')
    assertToolSchema(schema.items, `${path}[]`)
  }

  for (const key of ['properties', 'required', 'additionalProperties']) {
    if (Object.hasOwn(schema, key) && schema.type !== 'object') fail(`${key} richiede type object`)
  }
  if (schema.type === 'object') {
    if (!isObject(schema.properties)) fail('properties mancante o non valido')
    if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
      fail('additionalProperties deve essere booleano')
    }
    if (Object.hasOwn(schema, 'required') && (
      !Array.isArray(schema.required) ||
      schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties, key)) ||
      new Set(schema.required).size !== schema.required.length
    )) fail('required non valido')
    for (const [key, child] of Object.entries(schema.properties)) assertToolSchema(child, `${path}.${key}`)
  }
}

export function assertToolRegistration(tool, moduleId) {
  const fail = detail => { throw new TypeError(`Registrazione tool non valida (${tool?.name || moduleId || '?'}): ${detail}`) }
  for (const key of ['name', 'moduleId', 'credential', 'mode', 'risk', 'capabilityId']) {
    if (typeof tool?.[key] !== 'string' || !tool[key].trim()) fail(`${key} mancante`)
  }
  if (tool.moduleId !== moduleId) fail('moduleId diverso dal modulo registrante')
  if (typeof tool.requiresPrincipal !== 'boolean') fail('requiresPrincipal mancante')
  if (typeof tool.execute !== 'function') fail('execute non funzione')
  const definition = tool.definition
  if (definition?.type !== 'function' || definition.function?.name !== tool.name ||
      typeof definition.function?.description !== 'string' || !definition.function.description.trim() ||
      definition.function?.parameters?.type !== 'object') fail('definition incompleta o nome incoerente')
  assertToolSchema(definition.function.parameters)
}

export function parseToolArguments(value) {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch (_) {
      throw new ToolContractError('INVALID_TOOL_ARGUMENTS', 'Argomenti tool: JSON malformato.')
    }
  }
  if (!isObject(parsed)) {
    throw new ToolContractError('INVALID_TOOL_ARGUMENTS', 'Gli argomenti del tool devono essere un oggetto JSON.')
  }
  return parsed
}

export function validateToolArguments(tool, args) {
  const schema = tool.definition.function.parameters
  assertToolSchema(schema)
  const issues = []
  const add = (path, keyword) => { if (issues.length < 20) issues.push({path, keyword}) }
  const visit = (value, rule, path) => {
    const validType = rule.type === 'object' ? isObject(value)
      : rule.type === 'array' ? Array.isArray(value)
        : rule.type === 'null' ? value === null
          : rule.type === 'integer' ? Number.isInteger(value)
            : rule.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
              : typeof value === rule.type
    if (!validType) { add(path, 'type'); return }
    if (rule.enum && !rule.enum.some(item => isDeepStrictEqual(value, item))) add(path, 'enum')
    if (['number', 'integer'].includes(rule.type)) {
      if (value < rule.minimum) add(path, 'minimum')
      if (value > rule.maximum) add(path, 'maximum')
    }
    if (rule.type === 'array') {
      if (value.length < rule.minItems) add(path, 'minItems')
      if (value.length > rule.maxItems) add(path, 'maxItems')
      value.forEach((item, index) => visit(item, rule.items, `${path}[${index}]`))
    }
    if (rule.type === 'object') {
      for (const key of rule.required || []) {
        if (!Object.hasOwn(value, key)) add(`${path}.${key}`, 'required')
      }
      for (const [key, item] of Object.entries(value)) {
        if (Object.hasOwn(rule.properties, key)) visit(item, rule.properties[key], `${path}.${key}`)
        else if (rule.additionalProperties === false) add(`${path}.${key}`, 'additionalProperties')
      }
    }
  }
  visit(args, schema, '$')
  if (issues.length) throw new ToolContractError('TOOL_VALIDATION_ERROR', 'Argomenti tool non conformi alla definition.', issues)
  return args
}

export function assertAutomaticToolPolicy(tool, {credentials = {}, principal = null} = {}) {
  if (tool.mode !== 'read' || tool.risk !== 'low') {
    throw new ToolContractError('TOOL_POLICY_DENIED', 'Esecuzione automatica consentita solo per tool read/low.')
  }
  const credential = credentials?.[tool.credential]
  if (typeof credential !== 'string' || !credential.trim()) {
    throw new ToolContractError('TOOL_AUTHORIZATION_DENIED', 'Credenziale richiesta non disponibile.')
  }
  if (tool.requiresPrincipal && (
    typeof principal?.id !== 'string' || !principal.id.trim() || principal.source !== tool.credential
  )) {
    throw new ToolContractError('TOOL_AUTHORIZATION_DENIED', 'Principal autenticato richiesto per questa credenziale.')
  }
  const capability = getCapabilityCatalog({credentials}).find(item => item.id === tool.capabilityId)
  if (!capability?.available || capability.moduleId !== tool.moduleId ||
      capability.credential !== tool.credential || capability.mode !== tool.mode || capability.risk !== tool.risk) {
    throw new ToolContractError('TOOL_CAPABILITY_DENIED', 'Capability del tool non disponibile o incoerente.')
  }
}
