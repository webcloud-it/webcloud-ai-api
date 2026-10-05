import {getCapabilityCatalog} from '../capabilities/catalog.js'
import {parseToolArguments, validateToolArguments, ToolContractError} from '../tools/toolContract.js'

export const AGENT_OUTCOME = Object.freeze({
  HANDLED: 'HANDLED', CAPABILITY_NOT_MIGRATED: 'CAPABILITY_NOT_MIGRATED', ERROR: 'ERROR',
})
export const AGENT_CONTROL = 'agent_report_outcome'

// A control signal, never an application executor. It reports a direct model
// answer or requests an adapter; authorization/confirmation belong to the backend.
export function createAgentOutcomeControl({credentials, toolModuleId, tools}) {
  const capabilities = getCapabilityCatalog({credentials})
    .filter(item => !toolModuleId || item.moduleId === toolModuleId)
  return {
    capabilities,
    definition: {type: 'function', function: {
      name: AGENT_CONTROL,
      description: 'Comunica l’esito quando non usi un tool applicativo. Per saluti, spiegazioni o conversazione generale: outcome=GENERAL_CONVERSATION e reply con la risposta completa e breve. Per dati/azioni interni Webcloud non coperti dai tool nativi: outcome=CAPABILITY_NOT_MIGRATED e capabilityIds, senza reply. Non accede a dati e non esegue operazioni. Non usarlo per recuperare errori o permessi mancanti. Catalogo capability: ' + JSON.stringify(capabilities.map(item => ({
        id: item.id, description: item.description,
        nativeTools: tools.filter(tool => tool.capabilityId === item.id).map(tool => ({name: tool.name, description: tool.definition.function.description})),
      }))),
      parameters: {type: 'object', properties: {
        outcome: {type: 'string', enum: capabilities.length ? ['GENERAL_CONVERSATION', 'CAPABILITY_NOT_MIGRATED'] : ['GENERAL_CONVERSATION']},
        reply: {type: 'string', description: 'Solo GENERAL_CONVERSATION: risposta diretta nella lingua dell’utente, poche frasi complete.'},
        ...(capabilities.length ? {capabilityIds: {type: 'array', minItems: 1, maxItems: 4,
          items: {type: 'string', enum: capabilities.map(item => item.id)}}} : {}),
      }, required: ['outcome'], additionalProperties: false},
    }},
  }
}

export function validateAgentOutcomeControl(control, value, {credentials, principal}) {
  const args = parseToolArguments(value)
  validateToolArguments(control, args)
  if (args.outcome === 'GENERAL_CONVERSATION') {
    if (typeof args.reply !== 'string' || !args.reply.trim() || Object.hasOwn(args, 'capabilityIds')) {
      throw new ToolContractError('TOOL_VALIDATION_ERROR', 'La risposta conversazionale richiede reply e nessuna capability.')
    }
    return {generalReply: args.reply.trim()}
  }
  if (!args.capabilityIds?.length || Object.hasOwn(args, 'reply')) {
    throw new ToolContractError('TOOL_VALIDATION_ERROR', 'Il segnale di migrazione richiede capabilityIds e nessuna reply.')
  }
  if (typeof principal?.id !== 'string' || !principal.id.trim() || !principal.source) {
    throw new ToolContractError('TOOL_AUTHORIZATION_DENIED', 'Principal autenticato richiesto per il percorso legacy.')
  }
  const capabilities = [...new Set(args.capabilityIds)].map(id => control.capabilities.find(item => item.id === id))
  for (const item of capabilities) {
    const credential = credentials[item.credential]
    if (typeof credential !== 'string' || !credential.trim() ||
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
