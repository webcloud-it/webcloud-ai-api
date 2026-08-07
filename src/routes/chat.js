import express from 'express'
import {getModuleById} from '../modules/registry.js'
import {asyncHandler} from '../utils/asyncHandler.js'
import {getCredentialForModule} from '../core/capabilities/catalog.js'
import {
  buildGlobalClarificationResponse,
  buildGlobalGreetingResponse,
  buildGlobalHelpResponse,
  buildUnsupportedDomainResponse,
  buildUnavailableModuleResponse,
  resolveGlobalChatPlan,
} from '../core/orchestrator/globalChat.js'
import {recordChatAudit} from '../core/observability/chatAudit.js'
import {attachChatPresentation} from '../core/presentation/chatPresentation.js'

const router = express.Router()

router.post(
  '/',
  asyncHandler(async (req, res, next) => {
    const requestedModuleId = req.body?.moduleId || 'facile.renewals'
    const startedAt = Date.now()
    const sendJson = res.json.bind(res)

    res.json = rawPayload => {
      const payload = attachChatPresentation(rawPayload)
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

    if (globalPlan?.type === 'greeting') {
      return res.json(buildGlobalGreetingResponse({credentials: req.auth.credentials}))
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
    const module = getModuleById(moduleId)

    if (!module?.routes?.chat) {
      return res.status(404).json({
        ok: false,
        error: `Modulo AI non trovato o non conversazionale: ${moduleId}`,
      })
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

      const originalJson = res.json.bind(res)
      res.json = payload => {
        if (payload?.meta) {
          payload.meta = {
            ...payload.meta,
            moduleId,
            orchestrator: 'global-v1',
            routingSource: globalPlan.source,
          }
        }

        return originalJson(payload)
      }
    }

    return module.routes.chat(req, res, next)
  })
)

export default router
