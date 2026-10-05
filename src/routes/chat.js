import express from 'express'
import {getModuleById} from '../modules/registry.js'
import {asyncHandler} from '../utils/asyncHandler.js'
import {getCredentialForModule} from '../core/capabilities/catalog.js'
import {
  buildGlobalClarificationResponse,
  buildGlobalHelpResponse,
  buildMultiModuleResponse,
  buildUnsupportedDomainResponse,
  buildUnavailableModuleResponse,
  resolveGlobalChatPlan,
} from '../core/orchestrator/globalChat.js'
import {recordChatAudit} from '../core/observability/chatAudit.js'
import {attachChatPresentation} from '../core/presentation/chatPresentation.js'
import {env} from '../config/env.js'
import {buildInfo} from '../config/build.js'
import {executeMultiModuleRead} from '../core/orchestrator/multiModuleRead.js'
import {executeGlobalConversation} from '../core/orchestrator/globalConversation.js'
import {handleProposalDecision, rememberBackendProposal} from '../core/tools/proposalGate.js'

const router = express.Router()

router.post(
  '/',
  asyncHandler(async (req, res, next) => {
    const requestedModuleId = req.body?.moduleId || 'facile'
    const sessionToken = req.auth?.token
    let proposalModuleId = requestedModuleId
    const startedAt = Date.now()
    const sendJson = res.json.bind(res)

    res.json = rawPayload => {
      const proposalPayload = {...rawPayload, meta: {...rawPayload?.meta,
        moduleId: rawPayload?.meta?.moduleId || proposalModuleId}}
      rememberBackendProposal({payload: proposalPayload, auth: req.auth, sessionToken,
        credentialKey: getCredentialForModule(proposalPayload.meta.moduleId)})
      const payload = attachChatPresentation(rawPayload)
      payload.meta = {
        ...(payload.meta || {}),
        requestId: req.requestId,
        model: env.ollamaChatModel,
        buildId: buildInfo.id,
        buildCommit: buildInfo.commit,
      }
      recordChatAudit({
        requestId: req.requestId,
        requestedModuleId,
        moduleId: payload?.meta?.moduleId || req.body?.moduleId || requestedModuleId,
        intent: payload?.intent || payload?.meta?.intent || null,
        ok: payload?.ok === true,
        source: payload?.source || null,
        routingSource: payload?.meta?.routingSource || null,
        durationMs: Date.now() - startedAt,
        availableCredentials: Object.entries(req.auth?.credentials || {})
          .filter(([, value]) => Boolean(value))
          .map(([key]) => key),
      })

      return sendJson(payload)
    }
    const proposalDecision = await handleProposalDecision({
      body: req.body, auth: req.auth, getModule: getModuleById,
    })
    if (proposalDecision) return res.json(proposalDecision)

    const isGlobalRequest = ['facile', 'global', 'facile.global'].includes(requestedModuleId)
    const globalPlan = isGlobalRequest
      ? await resolveGlobalChatPlan({
          message: req.body?.message,
          context: req.body?.context,
          history: req.body?.history,
          credentials: req.auth.credentials,
        })
      : null

    if (globalPlan?.type === 'help') {
      return res.json(buildGlobalHelpResponse({credentials: req.auth.credentials}))
    }

    if (['conversation', 'greeting'].includes(globalPlan?.type)) {
      const result = await executeGlobalConversation({
        message: req.body?.message,
        history: req.body?.history,
        context: req.body?.context,
        credentials: req.auth?.credentials || {},
        principal: req.auth?.principal || null,
        routingSource: globalPlan?.source || 'conversation',
        requestId: req.requestId,
      })

      return res.json(result)
    }

    if (globalPlan?.type === 'multi-module') {
      const result = await executeMultiModuleRead({plan: globalPlan, req})
      return res.json(result || buildMultiModuleResponse(globalPlan))
    }

    if (globalPlan?.type === 'unsupported-domain') {
      return res.json(buildUnsupportedDomainResponse(globalPlan))
    }

    if (globalPlan?.type === 'clarification') {
      return res.json(buildGlobalClarificationResponse(globalPlan))
    }

    if (globalPlan?.type === 'unavailable') {
      return res.json(buildUnavailableModuleResponse(globalPlan))
    }

    const moduleId = globalPlan?.moduleId || requestedModuleId
    proposalModuleId = moduleId
    const module = getModuleById(moduleId)

    if (!module?.routes?.chat) {
      return res.status(404).json({
        ok: false,
        error: `Modulo AI non trovato o non conversazionale: ${moduleId}`,
      })
    }

    // Migrazione agent-first: se il modulo selezionato espone tool nativi,
    // lasciamo che sia Qwen a scegliere quale usare. Se non sceglie alcun
    // tool (o il modulo non ne espone ancora), executeGlobalConversation
    // restituisce null e preserviamo il vecchio handler come fallback.
    if (globalPlan?.type === 'module') {
      const agentResult = await executeGlobalConversation({
        message: req.body?.message,
        history: req.body?.history,
        context: req.body?.context,
        credentials: req.auth?.credentials || {},
        principal: req.auth?.principal || null,
        routingSource: globalPlan?.source || 'module',
        requestId: req.requestId,
        toolModuleId: moduleId,
        fallbackOnNoTool: true,
      })

      if (agentResult) return res.json(agentResult)
    }

    if (globalPlan) {
      const credentialKey = getCredentialForModule(moduleId)
      const credential = req.auth.credentials?.[credentialKey]

      req.auth = {
        ...req.auth,
        token: credential,
        selectedCredential: credentialKey,
      }
      req.body.moduleId = moduleId
      if (globalPlan.canonicalMessage) {
        req.body.originalMessage = req.body.message
        req.body.message = globalPlan.canonicalMessage
      }

      const originalJson = res.json.bind(res)
      res.json = payload => {
        if (payload?.meta) {
          payload.meta = {
            ...payload.meta,
            moduleId,
            orchestrator: 'global-v1',
            routingSource: globalPlan.source,
            semanticIntent: globalPlan.semantic?.intent || null,
            semanticConfidence: globalPlan.semantic?.confidence || null,
            semanticRelation: globalPlan.semantic?.relationToPrevious || null,
          }
        }

        return originalJson(payload)
      }
    }

    return module.routes.chat(req, res, next)
  })
)

export default router
