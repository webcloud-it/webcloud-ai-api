import {buildCapabilitySummary, getCapabilityCatalog} from '../capabilities/catalog.js'
import {getModuleById} from '../../modules/registry.js'
import {parseToolArguments, validateToolArguments, ToolContractError} from '../tools/toolContract.js'

export const AGENT_OUTCOME = Object.freeze({
  HANDLED: 'HANDLED', CAPABILITY_NOT_MIGRATED: 'CAPABILITY_NOT_MIGRATED', ERROR: 'ERROR',
})
export const AGENT_CONTROL = 'agent_report_outcome'

// A control signal, never an application executor. It reports a direct model
// answer or requests an adapter; authorization/confirmation belong to the backend.
export function createAgentOutcomeControl({credentials, principal, toolModuleId, tools = []}) {
  // Labels are control arguments, never function names. Technical permission IDs
  // and the label -> module -> permission mapping remain entirely backend-side.
  const authenticated = typeof principal?.id === 'string' && principal.id.trim() && principal.source
  const capabilities = getCapabilityCatalog({credentials}).filter(item => {
    const credential = credentials[item.credential]
    return typeof credential === 'string' && credential.trim() &&
      (item.credential !== 'crm' || principal?.source === 'crm')
  })
  const areas = authenticated ? buildCapabilitySummary({credentials}).filter(item => {
    return (!toolModuleId || item.moduleId === toolModuleId) &&
      typeof getModuleById(item.moduleId)?.routes?.chat === 'function' &&
      capabilities.some(capability => capability.moduleId === item.moduleId)
  }).map(item => ({label: item.title, moduleId: item.moduleId,
    capabilityIds: capabilities.filter(capability => capability.moduleId === item.moduleId).map(capability => capability.id),
    descriptions: capabilities.filter(capability => capability.moduleId === item.moduleId).map(capability => capability.description)})) : []
  return {
    areas,
    legacySummary: areas.map(item => ({area: item.label, descriptions: item.descriptions})),
    definition: {type: 'function', function: {
      name: AGENT_CONTROL,
      description: 'Comunica l’esito quando non usi un tool applicativo. Per saluti, spiegazioni o conversazione generale: outcome=GENERAL_CONVERSATION e reply con la risposta completa e breve. Per dati/azioni interni Webcloud non coperti dai tool nativi: outcome=CAPABILITY_NOT_MIGRATED e legacyAreas con le etichette delle aree applicative, senza reply. Non accede a dati e non esegue operazioni. Non usarlo per recuperare errori o permessi mancanti. CALLABLE TOOLS dal registry: ' + JSON.stringify(tools.map(tool => ({name: tool.name, description: tool.definition.function.description}))) + '. Legacy application areas available for fallback (NON CALLABLE; valori dell’argomento legacyAreas): ' + JSON.stringify(areas.map(item => ({area: item.label, descriptions: item.descriptions}))),
      parameters: {type: 'object', properties: {
        outcome: {type: 'string', enum: areas.length ? ['GENERAL_CONVERSATION', 'CAPABILITY_NOT_MIGRATED'] : ['GENERAL_CONVERSATION']},
        reply: {type: 'string', description: 'Solo GENERAL_CONVERSATION: risposta diretta nella lingua dell’utente, poche frasi complete.'},
        ...(areas.length ? {legacyAreas: {type: 'array', minItems: 1, maxItems: 4,
          description: 'Solo CAPABILITY_NOT_MIGRATED: etichette delle aree legacy non callable; il backend verifica scope e autorizzazione.',
          items: {type: 'string', enum: areas.map(item => item.label)}}} : {}),
      }, required: ['outcome'], additionalProperties: false},
    }},
  }
}

export function validateAgentOutcomeControl(control, value, {credentials, principal}) {
  const args = parseToolArguments(value)
  validateToolArguments(control, args)
  if (args.outcome === 'GENERAL_CONVERSATION') {
    if (typeof args.reply !== 'string' || !args.reply.trim() || Object.hasOwn(args, 'legacyAreas')) {
      throw new ToolContractError('TOOL_VALIDATION_ERROR', 'La risposta conversazionale richiede reply e nessuna capability.')
    }
    return {generalReply: args.reply.trim()}
  }
  if (!args.legacyAreas?.length || Object.hasOwn(args, 'reply')) {
    throw new ToolContractError('TOOL_VALIDATION_ERROR', 'Il segnale di migrazione richiede legacyAreas e nessuna reply.')
  }
  if (typeof principal?.id !== 'string' || !principal.id.trim() || !principal.source) {
    throw new ToolContractError('TOOL_AUTHORIZATION_DENIED', 'Principal autenticato richiesto per il percorso legacy.')
  }
  const areas = [...new Set(args.legacyAreas)].map(label => control.areas.find(item => item.label === label))
  const catalog = getCapabilityCatalog({credentials})
  for (const area of areas) {
    if (!area || typeof getModuleById(area.moduleId)?.routes?.chat !== 'function') {
      throw new ToolContractError('TOOL_CAPABILITY_DENIED', 'Adapter legacy non disponibile.')
    }
  }
  const capabilities = areas.flatMap(area => area.capabilityIds.map(id => catalog.find(item => item.id === id && item.moduleId === area.moduleId)))
  for (const item of capabilities) {
    const credential = credentials[item?.credential]
    if (!item || typeof credential !== 'string' || !credential.trim() ||
        (item.credential === 'crm' && principal.source !== 'crm')) {
      throw new ToolContractError('TOOL_AUTHORIZATION_DENIED', 'Credenziale richiesta non disponibile per la capability.')
    }
  }
  return {capabilityIds: capabilities.map(item => item.id), moduleIds: [...new Set(capabilities.map(item => item.moduleId))]}
}

export function agentOutcome(response) {
  if (response?.meta?.toolErrors?.length || response?.meta?.maxIterationsReached || response?.ok !== true) return AGENT_OUTCOME.ERROR
  return response?.meta?.capabilityNotMigrated ? AGENT_OUTCOME.CAPABILITY_NOT_MIGRATED : AGENT_OUTCOME.HANDLED
}
