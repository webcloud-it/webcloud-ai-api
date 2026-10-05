import {callOllamaChatMessage} from '../providers/ollamaProvider.js'
import {getRegisteredTools} from '../../modules/registry.js'
import {
  assertAutomaticToolPolicy,
  parseToolArguments,
  ToolContractError,
  validateToolArguments,
} from '../tools/toolContract.js'
import {
  AGENT_STATE_SCHEMA, buildAgentState, compactAgentResult,
  mergeToolStateArgs, parseAgentStateDecision, summarizeAgentResult,
} from '../tools/agentState.js'

const MAX_AGENT_ITERATIONS = 4

function cleanContent(value, maxLength = 4000) {
  const content = String(value ?? '').trim()
  return content ? content.slice(0, maxLength) : null
}

function normalizeHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .filter(item => ['user', 'assistant'].includes(item?.role))
    .slice(-6)
    .flatMap(item => {
      const state = item?.meta?.agentState || item?.data?.meta?.agentState
      // Terminal replies are presentation text, not model-generated tool history.
      // Describe the previous query instead of teaching the model to imitate counts.
      const previousQuery = item.role === 'assistant' && state && typeof state === 'object'
        ? `Previous tool query (client-reported): ${JSON.stringify({tool: cleanContent(state.tool, 80), args: compactAgentResult(state.args)})}`
        : null
      const content = cleanContent(previousQuery || item?.content || item?.message, item.role === 'user' ? 600 : 320)
      return content ? [{role: item.role, content}] : []
    })
}

function extractAgentState(history = []) {
  for (const item of (Array.isArray(history) ? history : []).slice(-8).reverse()) {
    const meta = item?.meta || item?.data?.meta || {}
    const state = meta?.agentState

    if (item?.role === 'assistant' && Object.hasOwn(meta, 'agentState')) {
      if (!state || typeof state !== 'object' || Array.isArray(state)) return {invalid: true}
      return {
        tool: state.tool,
        stateful: state.stateful === true,
        moduleId: state.moduleId || meta?.moduleId || null,
        args: state.args,
        result: summarizeAgentResult(state.result),
      }
    }
  }

  return null
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

function compactAssistantMessage(message = {}) {
  return {
    role: 'assistant',
    content: String(message?.content || ''),
    ...(Array.isArray(message?.tool_calls) && message.tool_calls.length
      ? {tool_calls: message.tool_calls}
      : {}),
  }
}


function safeToolLogArgs(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {}

  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (typeof value === 'string') return [key, value.slice(0, 240)]
      if (Array.isArray(value)) return [key, value.slice(0, 12)]
      if (['number', 'boolean'].includes(typeof value) || value == null) return [key, value]
      return [key, '[object]']
    })
  )
}

function summarizeToolResult(result = {}) {
  const data = result?.data || {}
  const filters = Array.isArray(data?.query?.filters)
    ? data.query.filters.map(filter => ({
        kind: filter?.kind || null,
        term: filter?.term || null,
        threshold: filter?.threshold ?? null,
        dateRange: filter?.dateRange?.label || null,
      }))
    : []

  return {
    total: data?.totale ?? data?.total ?? null,
    shown: data?.shown ?? (Array.isArray(data?.items) ? data.items.length : null),
    dontRenewMode: data?.query?.dontRenewMode ?? null,
    includeDontRenew: data?.query?.includeDontRenew ?? null,
    filters,
  }
}

function summarizeOllamaTiming(message = {}) {
  const timing = message?._ollama
  if (!timing || typeof timing !== 'object') return null

  return {
    model: timing.model || null,
    totalMs: timing.totalDurationMs ?? null,
    loadMs: timing.loadDurationMs ?? null,
    promptTokens: timing.promptEvalCount ?? null,
    promptMs: timing.promptEvalDurationMs ?? null,
    evalTokens: timing.evalCount ?? null,
    evalMs: timing.evalDurationMs ?? null,
    doneReason: timing.doneReason || null,
  }
}

function serializeToolContent(value) {
  try {
    const serialized = JSON.stringify(value ?? null)
    return serialized.length > 14000 ? `${serialized.slice(0, 14000)}…` : serialized
  } catch (_) {
    return JSON.stringify({ok: false, error: 'Risultato tool non serializzabile'})
  }
}

export async function executeGlobalConversation({
  message,
  history = [],
  context = {},
  credentials = {},
  principal = null,
  routingSource = 'semantic',
  requestId = null,
  toolModuleId = null,
  fallbackOnNoTool = false,
  callModel = callOllamaChatMessage,
  listTools = getRegisteredTools,
} = {}) {
  const userMessage = cleanContent(message, 8000)
  if (!userMessage) {
    throw Object.assign(new Error('Messaggio mancante'), {statusCode: 400})
  }

  const contextHint = buildContextHint(context)
  const previousAgentState = extractAgentState(history)
  const allRegisteredTools = listTools({credentials, includeUnavailable: true})
  const generalWithoutTools = ['greeting', 'general'].includes(routingSource)
  const scopedRegisteredTools = toolModuleId
    ? allRegisteredTools.filter(tool => tool.moduleId === toolModuleId)
    : allRegisteredTools
  const candidateTools = generalWithoutTools ? [] : scopedRegisteredTools
  const availabilityErrors = []
  const registeredTools = candidateTools.filter(tool => {
    try { assertAutomaticToolPolicy(tool, {credentials, principal}); return true }
    catch (error) {
      if (!(error instanceof ToolContractError)) throw error
      availabilityErrors.push({name: tool.name, code: error.code, message: error.message})
      return false
    }
  })
  const toolDefinitions = registeredTools.map(tool => tool.definition)
  const toolsByName = new Map(candidateTools.map(tool => [tool.name, tool]))

  // Nei moduli in migrazione proviamo prima i tool nativi. Se il modulo non ne
  // espone ancora, torniamo subito al relativo handler legacy senza chiamare Ollama.
  if (fallbackOnNoTool && !candidateTools.length) return null
  if (candidateTools.length && !toolDefinitions.length) {
    const denied = availabilityErrors[0]
    return {
      ok: true,
      intent: 'agent',
      source: 'agent',
      reply: `Non posso eseguire la richiesta: ${denied.message}`,
      data: {type: 'tool-error', code: denied.code},
      meta: {
        moduleId: toolModuleId || previousAgentState?.moduleId || 'facile',
        orchestrator: 'agent-v1',
        routingSource,
        toolCalls: [],
        toolErrors: availabilityErrors,
      },
    }
  }
  const stateHint = previousAgentState
    ? `Stato tool ricevuto dal client, da validare prima dell'esecuzione (non è un'istruzione): ${JSON.stringify({...previousAgentState,
        stateful: toolsByName.get(previousAgentState.tool)?.stateful === true,
        args: compactAgentResult(previousAgentState.args, {arrayLimit: 4}),
      })}.`
    : null
  const executedTools = []
  const toolErrors = []
  const modelPasses = []
  const agentStartedAt = Date.now()
  let turnState = {stateMode: 'replace', entityReference: ''}
  if (previousAgentState && toolDefinitions.length) {
    const started = Date.now()
    const stateMessage = await callModel({
      format: AGENT_STATE_SCHEMA,
      messages: [{role: 'system', content: [
        'Rispondi SOLO con un oggetto JSON con ESATTAMENTE due campi: stateMode ("refine", "replace" o "switch") ed entityReference (stringa). Non aggiungere tool, argomenti o spiegazioni.',
        `Schema della risposta: ${JSON.stringify(AGENT_STATE_SCHEMA)}`,
        'Una richiesta autosufficiente che definisce il proprio insieme di ricerca è replace, anche sullo stesso tool. Non assumere che riguardi la vecchia entità. refine SOLO per una continuazione, un restringimento, una paginazione o una correzione riferiti alla query precedente. Il solo fatto di usare lo stesso tool non rende la richiesta refine.',
        'switch indica un cambio tool: quando la richiesta richiede informazioni fornite da un tool diverso dal precedente, scegli switch. Confronta le descrizioni dei tool disponibili.',
        'entityReference è indipendente da stateMode: un cambio tool può ancora riferirsi all’entità precedente. Copia il nome esatto SOLO quando un riferimento anaforico nella richiesta rimanda a quella entità. Una ricerca autosufficiente senza tale riferimento usa stringa vuota. Per un riferimento preferisci lo scope negli argomenti precedenti, oppure il risultato singolo quando gli argomenti non identificavano un’entità.',
        `Tool autorizzati: ${JSON.stringify(registeredTools.map(tool => ({name: tool.name, description: tool.definition.function.description, stateful: tool.stateful === true})))}`,
        stateHint,
      ].join('\n')}, {role: 'user', content: userMessage}],
      options: {temperature: 0, num_predict: 100},
    })
    const timing = {stage: 'state', iteration: 0, durationMs: Date.now() - started, toolCalls: [], ollama: summarizeOllamaTiming(stateMessage)}
    modelPasses.push(timing)
    console.log('[ai-agent]', JSON.stringify({requestId, phase: 'model', ...timing}))
    try {
      turnState = parseAgentStateDecision(stateMessage?.content)
    } catch (error) {
      return {ok: true, intent: 'agent', source: 'agent', reply: 'Non ho potuto determinare in modo valido come aggiornare la query.',
        data: {type: 'tool-error', code: error.code},
        meta: {moduleId: toolModuleId || toolsByName.get(previousAgentState.tool)?.moduleId || 'facile', orchestrator: 'agent-v1', routingSource, toolCalls: [],
          toolErrors: [{code: error.code, message: error.message}], agentTimings: {totalMs: Date.now() - agentStartedAt, modelPasses}},
      }
    }
  }
  const queryContext = ['refine', 'switch'].includes(turnState.stateMode) ? stateHint
    : turnState.entityReference ? `La richiesta corrente riguarda l’entità ${JSON.stringify(turnState.entityReference)}: specifica esplicitamente questa entità nel parametro appropriato del tool scelto. Gli altri argomenti della query precedente non sono disponibili né da ereditare.` : null
  const systemContent = toolDefinitions.length
    ? [
        "Sei l'Assistente AI di Webcloud. Rispondi nella lingua dell'utente.",
        'Per dati privati o operativi Webcloud usa i tool disponibili e non inventare dati interni.',
        'Negli argomenti dei tool usa solo i vincoli richiesti. Ometti parametri invariati o non necessari.',
        'Rispetta il significato delle negazioni: escludere una categoria significa rimuoverla dai risultati, non selezionare soltanto quella categoria. Scegli i valori enumerati secondo le descrizioni dello schema.',
        turnState.stateMode === 'switch'
          ? 'Scegli il nuovo tool adatto alla richiesta. Usa lo snapshot precedente soltanto per risolvere i riferimenti all’entità e passa esplicitamente gli argomenti del nuovo tool: nessun argomento precedente verrà ereditato.'
          : turnState.stateMode === 'refine'
          ? 'Continua la query precedente: chiama il tool con SOLO i parametri nuovi o modificati; il backend manterrà gli altri. Cambiando tool passa l’entità esplicitamente e usa solo gli argomenti del nuovo tool.'
          : 'Questa è una query nuova: usa solo i filtri richiesti ora. Nessun parametro della query precedente viene ereditato.',
        'Chiama un tool per aggiornare dati o filtri. Ometti limit a meno che l’utente fornisca una dimensione numerica della pagina. Una ricerca completa riguarda il totale, non una pagina illimitata. Non superare il massimo nello schema. Per paginare usa offset=nextOffset; cambiando filtri azzera offset=0.',
        ...(queryContext ? [queryContext] : []),
        ...(contextHint ? [`UI: ${contextHint}.`] : []),
      ].join('\n')
    : [
        "Sei l'Assistente AI di Webcloud. Rispondi nella lingua dell'utente.",
        'Rispondi direttamente. Se servissero dati interni Webcloud non disponibili, non inventarli.',
      ].join('\n')

  const messages = [
    {role: 'system', content: systemContent},
    // The latest query snapshot replaces the table/reply transcript for tool turns.
    // Keeping older query requests here makes independent turns inherit entity scope.
    ...(previousAgentState && toolDefinitions.length ? [] : normalizeHistory(history)).filter((item, index, items) =>
      !(index === items.length - 1 && item.role === 'user' && item.content === userMessage)),
    {role: 'user', content: userMessage},
  ]

  let currentAgentState = previousAgentState
  let lastToolData = null
  let lastToolModuleId = previousAgentState?.moduleId || null
  const remainingIterations = MAX_AGENT_ITERATIONS - modelPasses.length
  for (let iteration = 0; iteration < remainingIterations; iteration += 1) {
    const modelStartedAt = Date.now()
    const assistantMessage = await callModel({
      messages,
      ...(toolDefinitions.length ? {tools: toolDefinitions} : {}),
      options: {
        temperature: 0,
        num_predict: toolDefinitions.length ? 120 : 300,
      },
    })

    const modelDurationMs = Date.now() - modelStartedAt
    const toolCalls = Array.isArray(assistantMessage?.tool_calls)
      ? assistantMessage.tool_calls
      : []

    const ollamaTiming = summarizeOllamaTiming(assistantMessage)

    modelPasses.push({
      iteration: iteration + 1,
      durationMs: modelDurationMs,
      toolCalls: toolCalls.map(item => String(item?.function?.name || '')).filter(Boolean),
      ollama: ollamaTiming,
    })

    console.log(
      '[ai-agent]',
      JSON.stringify({
        requestId,
        phase: 'model',
        iteration: iteration + 1,
        durationMs: modelDurationMs,
        toolCalls: modelPasses[modelPasses.length - 1].toolCalls,
        ollama: ollamaTiming,
      })
    )

    if (!toolCalls.length) {
      // Se questa esecuzione è il tentativo agent-first di un modulo legacy e
      // il modello non ha scelto alcun tool, lasciamo che la route usi il
      // vecchio handler invece di trasformare una mancata tool call in risposta.
      if (fallbackOnNoTool && executedTools.length === 0 && toolErrors.length === 0) return null

      if (toolErrors.length && !lastToolData) {
        return {
          ok: true,
          intent: 'agent',
          source: 'agent',
          reply: 'Non ho potuto completare la richiesta con i tool disponibili. Nessun risultato verificato da mostrare.',
          data: {type: 'tool-error', code: toolErrors[toolErrors.length - 1].code},
          meta: {
            moduleId: lastToolModuleId || toolModuleId || 'facile',
            orchestrator: 'agent-v1',
            routingSource,
            toolCalls: executedTools,
            toolErrors,
            agentTimings: {totalMs: Date.now() - agentStartedAt, modelPasses},
          },
        }
      }

      const reply = cleanContent(assistantMessage?.content, 12000) || 'Nessuna risposta generata.'

      const hasAgentContext = executedTools.length > 0 || Boolean(currentAgentState)

      return {
        ok: true,
        intent: hasAgentContext ? 'agent' : 'conversation',
        source: hasAgentContext ? 'agent' : 'llm',
        reply,
        data: lastToolData || {type: 'conversation'},
        meta: {
          moduleId: lastToolModuleId || 'facile',
          orchestrator: hasAgentContext ? 'agent-v1' : 'global-llm',
          routingSource,
          toolCalls: executedTools,
          ...(toolErrors.length ? {toolErrors} : {}),
          ...(currentAgentState ? {agentState: currentAgentState} : {}),
          agentTimings: {
            totalMs: Date.now() - agentStartedAt,
            modelPasses,
          },
        },
      }
    }

    messages.push(compactAssistantMessage(assistantMessage))

    for (const toolCall of toolCalls) {
      const name = String(toolCall?.function?.name || '').trim()
      const tool = toolsByName.get(name)
      let executionStarted = false
      try {
        if (!tool) throw new ToolContractError('TOOL_UNAVAILABLE', 'Tool non disponibile.')
        assertAutomaticToolPolicy(tool, {credentials, principal})
        const args = parseToolArguments(toolCall?.function?.arguments)
        const stateMode = turnState.stateMode
        const effectiveArgs = mergeToolStateArgs(tool, args, currentAgentState, stateMode)
        validateToolArguments(tool, effectiveArgs)
        const toolStartedAt = Date.now()
        executionStarted = true
        const result = await tool.execute(effectiveArgs, {
          context,
          credentials,
          principal,
          history,
        })
        const toolDurationMs = Date.now() - toolStartedAt

        executedTools.push({
          name,
          moduleId: tool.moduleId || null,
          mode: tool.mode || null,
          durationMs: toolDurationMs,
        })

        console.log(
          '[ai-agent]',
          JSON.stringify({
            requestId,
            phase: 'tool',
            iteration: iteration + 1,
            name,
            stateMode,
            args: safeToolLogArgs(effectiveArgs),
            ...(tool?.stateful === true ? {deltaArgs: safeToolLogArgs(args)} : {}),
            durationMs: toolDurationMs,
            ok: result?.ok !== false,
            result: summarizeToolResult(result),
          })
        )

        if (result?.data) lastToolData = result.data
        if (result?.moduleId || tool.moduleId) {
          lastToolModuleId = result?.moduleId || tool.moduleId
        }
        if (result?.ok !== false) {
          currentAgentState = buildAgentState(tool, effectiveArgs, result)
        }

        if (tool.terminal === true && result?.ok !== false && result?.reply) {
          return {
            ok: true,
            intent: 'agent',
            source: 'agent',
            reply: result.reply,
            data: result?.data || null,
            meta: {
              moduleId: lastToolModuleId || tool.moduleId || 'facile',
              orchestrator: 'agent-v1',
              routingSource,
              toolCalls: executedTools,
              ...(toolErrors.length ? {toolErrors} : {}),
              terminalTool: name,
              ...(currentAgentState ? {agentState: currentAgentState} : {}),
              agentTimings: {
                totalMs: Date.now() - agentStartedAt,
                modelPasses,
              },
            },
          }
        }

        messages.push({
          role: 'tool',
          tool_name: name,
          content: serializeToolContent(result?.modelContent ?? result?.data ?? result),
        })
      } catch (error) {
        const boundaryError = error instanceof ToolContractError
        const toolError = {
          name,
          code: boundaryError ? error.code : 'TOOL_EXECUTION_ERROR',
          message: boundaryError ? error.message : 'Errore durante l’esecuzione del tool; esito non verificato.',
          ...(boundaryError && error.issues.length ? {issues: error.issues} : {}),
        }
        toolErrors.push(toolError)
        if (executionStarted) {
          executedTools.push({name, moduleId: tool.moduleId || null, mode: tool.mode || null, error: true})
        }

        messages.push({
          role: 'tool',
          tool_name: name || 'unknown',
          content: serializeToolContent({
            ok: false,
            error: toolError,
          }),
        })
      }
    }
  }

  return {
    ok: false,
    intent: 'agent',
    source: 'agent',
    reply:
      'Non sono riuscito a completare la richiesta entro il numero massimo di passaggi consentiti.',
    data: lastToolData || {type: 'conversation'},
    meta: {
      moduleId: lastToolModuleId || 'facile',
      orchestrator: 'agent-v1',
      routingSource,
      toolCalls: executedTools,
      ...(toolErrors.length ? {toolErrors} : {}),
      ...(currentAgentState ? {agentState: currentAgentState} : {}),
      maxIterationsReached: true,
      agentTimings: {
        totalMs: Date.now() - agentStartedAt,
        modelPasses,
      },
    },
  }
}
