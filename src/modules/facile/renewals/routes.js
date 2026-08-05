import {
  getAllServices,
  getSettings,
  getPanelCounts,
  getServiceOptions,
  queryRenewalsCatalog,
  previewRenewalsCatalogMutation,
  commitRenewalsCatalogMutation,
  getPleskRenewalsAudit,
} from './service.js'
import {
  handlePendingRenewalsDiagnosticClarification,
  handlePleskAuditRequest,
  handleServiceHttpCheckRequest,
  handleServiceSubscriptionExpiryRequest,
  hasPendingRenewalsDiagnosticClarification,
  parsePleskAuditRequest,
  parseServiceHttpCheckRequest,
  parseServiceSubscriptionExpiryRequest,
} from './diagnostics.js'
import {getClientSubscriptions, isLowOnSpace, buildServiceSnapshot} from './snapshots.js'
import {matchesText} from './intents.js'
import {buildCommunicationsIndex} from './communications.js'
import {
  buildCommunicationDraftPreview,
  handlePendingCommunicationDraftClarification,
  hasPendingCommunicationDraftClarification,
  planCommunicationDraftRequest,
} from './communicationDrafts.js'
import {
  buildOpenEmailGenerationAction,
  handlePendingOpenEmailGenerationClarification,
  hasPendingOpenEmailGenerationClarification,
  planOpenEmailGenerationAction,
} from './appActions.js'
import {buildChatContextFromSnapshots} from './context.js'
import {handleRenewalsChat} from './chat.js'
import {httpError} from '../../../utils/httpError.js'
import {buildTodoPayloadFromServices} from './todos.js'
import {planChatRequest} from '../../../core/planner/chatPlanner.js'
import {planReadQuery} from './readQueryPlanner.js'
import {executeReadQuery} from './readQueryExecutor.js'
import {buildReadQueryReply} from './readQueryFormatters.js'
import {
  clearRememberedReadQueryContext,
  rememberReadQueryContext,
} from './readQueryContext.js'
import {
  buildReadQueryTargetClarification,
  resolveReadQueryDetailTarget,
  shouldResolveReadQueryDetailTarget,
} from './readQueryTargetResolver.js'
import {
  clearPendingReadQueryTargetClarification,
  rememberReadQueryTargetClarification,
  resolvePendingReadQueryTargetClarification,
} from './readQueryClarifications.js'
import {canExecuteReadQueryFromCatalog} from './readEntityRegistry.js'
import {
  interpretReadQueryUtterance,
  parseReadQueryUtterance,
} from './readQueryUtterance.js'
import {
  buildEntityMutationProposal,
  buildRecentEntityMutationUndoProposal,
  getRecentCompletedEntityMutationContext,
  handlePendingEntityMutationDecisionMessage,
  isRecentEntityMutationUndoRequest,
} from './entityMutationActions.js'
import {planEntityMutationRequest} from './entityMutationPlanner.js'
import {
  isGenericOperationUndoRequest,
  pickLatestCompletedOperation,
} from './operationUndoResolver.js'
import {verifyCompletedOperationResult} from './operationVerification.js'
import {
  buildCopySupplierExpiryToCustomerActionPreview,
  buildRecentRenewalsActionUndoPreview,
  getRecentCompletedRenewalsActionContext,
  getRecentRenewalsActionTarget,
  buildServiceAuthCodeActionPreview,
  buildServiceFlagActionPreview,
  buildServiceInvoiceDateActionPreview,
  buildServicePleskPlanSyncActionPreview,
  buildServiceSubscriptionEndDateActionPreview,
  buildServiceTransferTargetActionPreview,
  handlePendingRenewalsActionClarification,
  handlePendingRenewalsActionDecisionMessage,
  hasPendingRenewalsActionClarification,
  handleRenewalsActionDecision,
  isRecentRenewalsActionUndoRequest,
  parseCopySupplierExpiryToCustomerAction,
  parseServiceAuthCodeAction,
  parseServiceFlagAction,
  parseServiceInvoiceDateAction,
  parseServicePleskPlanSyncAction,
  parseServiceSubscriptionEndDateAction,
  parseServiceTransferTargetAction,
} from './actions.js'
import {
  handleFullRenewalPreviewRequest,
  handlePendingFullRenewalPreviewClarification,
  hasPendingFullRenewalPreviewClarification,
  parseFullRenewalPreviewRequest,
} from './fullRenewalPreview.js'
import {
  buildRecentCompletedFullRenewalUndoReply,
  getRecentCompletedFullRenewalContext,
  getRecentCompletedFullRenewalTarget,
  handleFullRenewalExecutionDecision,
  handleFullRenewalExecutionRequest,
  handlePendingFullRenewalExecutionClarification,
  handlePendingFullRenewalExecutionDecisionMessage,
  hasFullRenewalExecutionProposal,
  hasPendingFullRenewalExecutionClarification,
  isRecentCompletedFullRenewalUndoRequest,
  parseFullRenewalExecutionRequest,
} from './fullRenewalExecution.js'
import {
  handlePendingRenewalPreviewClarification,
  handleRenewalPreviewRequest,
  hasPendingRenewalPreviewClarification,
  parseRenewalPreviewRequest,
} from './renewalPreview.js'
import {
  handlePendingSupplierRenewalPreviewClarification,
  handleSupplierRenewalPreviewRequest,
  hasPendingSupplierRenewalPreviewClarification,
  parseSupplierRenewalPreviewRequest,
} from './supplierRenewalPreview.js'
import {
  buildRecentCompletedSupplierRenewalUndoReply,
  getRecentCompletedSupplierRenewalContext,
  getRecentCompletedSupplierRenewalTarget,
  handlePendingSupplierRenewalExecutionClarification,
  handlePendingSupplierRenewalExecutionDecisionMessage,
  handleSupplierRenewalExecutionDecision,
  handleSupplierRenewalExecutionRequest,
  hasPendingSupplierRenewalExecutionClarification,
  hasSupplierRenewalExecutionProposal,
  isRecentCompletedSupplierRenewalUndoRequest,
  parseSupplierRenewalExecutionRequest,
} from './supplierRenewalExecution.js'
import {
  buildRecentCompletedRenewalUndoReply,
  getRecentCompletedRenewalContext,
  getRecentCompletedRenewalTarget,
  handlePendingRenewalExecutionClarification,
  handlePendingRenewalExecutionDecisionMessage,
  handleRenewalExecutionDecision,
  handleRenewalExecutionRequest,
  hasPendingRenewalExecutionClarification,
  hasRenewalExecutionProposal,
  isRecentCompletedRenewalUndoRequest,
  parseRenewalExecutionRequest,
} from './renewalExecution.js'

export async function summary(req, res) {
  const token = req.auth.token
  const {customerId} = req.query

  const [services, settings] = await Promise.all([getAllServices(), getSettings()])

  const analysisPeriod = Number(settings.analysis_period ?? 30)
  const now = new Date()
  const limit = new Date(now.getTime() + analysisPeriod * 864e5)

  const filtered = services.filter(s => (customerId ? s.customer?.id === customerId : true))

  let inScadenza = 0
  let spazioEsaurito = 0
  let inEsaurimento = 0

  for (const s of filtered) {
    for (const sub of getClientSubscriptions(s)) {
      if (!sub.endsOn) continue
      const d = new Date(sub.endsOn)

      if (d >= now && d <= limit) inScadenza++
    }

    const used = s?.pleskDomain?.statsDiskUsage?.totalSize || 0
    const quota = s?.pleskDomain?.statsDiskUsage?.quota || 0

    if (quota && used / quota >= 1) spazioEsaurito++
    else if (isLowOnSpace(quota, (used / quota) * 100, settings.renewals_low_thresholds || [])) {
      inEsaurimento++
    }
  }

  res.json({
    totale: filtered.length,
    inScadenza,
    spazioEsaurito,
    inEsaurimento,
  })
}

export async function todo(req, res) {
  const {customerId} = req.query

  const [services, settings] = await Promise.all([getAllServices(), getSettings()])

  const payload = buildTodoPayloadFromServices({
    services,
    settings,
    customerId,
  })

  res.json({
    totale: payload.totale,
    items: payload.items,
  })
}

export async function customerReport(req, res) {
  const token = req.auth.token
  const {customerId} = req.query

  if (!customerId) {
    throw httpError(400, 'customerId obbligatorio')
  }

  const [services, settings] = await Promise.all([getAllServices(), getSettings()])

  const analysisPeriod = Number(settings.analysis_period ?? 30)
  const thresholds = settings.renewals_low_thresholds || []

  const filtered = services.filter(s => String(s?.customer?.id) === String(customerId))
  const snapshots = filtered.map(s => buildServiceSnapshot(s, thresholds, analysisPeriod))

  const total = snapshots.length
  const expiring = snapshots.filter(s => s.expiringCount > 0)
  const urgent = snapshots.filter(s => s.urgentRenewalsCount > 0)
  const full = snapshots.filter(s => s.isFull)
  const low = snapshots.filter(s => s.isLow && !s.isFull)
  const dontRenew = snapshots.filter(s => s.dontRenew)

  const customerName = snapshots[0]?.customerName || '—'

  const priorities = [
    ...full.map(s => ({
      tipo: 'upgrade',
      priorita: 'alta',
      servizio: s.name,
      msg: 'Spazio esaurito',
    })),
    ...urgent.map(s => ({
      tipo: 'rinnovo',
      priorita: 'alta',
      servizio: s.name,
      msg: `Rinnovo urgente${s.nextRenewalDate ? ` entro ${s.nextRenewalDate}` : ''}`,
    })),
    ...low.map(s => ({
      tipo: 'upgrade',
      priorita: 'media',
      servizio: s.name,
      msg: `Spazio in esaurimento (${s.percent.toFixed(1)}%)`,
    })),
    ...dontRenew.map(s => ({
      tipo: 'verifica',
      priorita: 'media',
      servizio: s.name,
      msg: 'Servizio marcato NON RINNOVARE',
    })),
  ].slice(0, 10)

  res.json({
    customerId,
    customerName,
    analysisPeriod,
    summary: {
      total,
      expiring: expiring.length,
      urgent: urgent.length,
      full: full.length,
      low: low.length,
      dontRenew: dontRenew.length,
    },
    priorities,
    text:
      `Cliente: ${customerName}\n` +
      `Servizi totali: ${total}\n` +
      `Rinnovi imminenti: ${expiring.length}\n` +
      `Rinnovi urgenti: ${urgent.length}\n` +
      `Spazio esaurito: ${full.length}\n` +
      `Spazio in esaurimento: ${low.length}\n` +
      `Non rinnovare: ${dontRenew.length}`,
  })
}

export async function groupReport(req, res) {
  const token = req.auth.token
  const {groupId} = req.query

  if (!groupId) {
    throw httpError(400, 'groupId obbligatorio')
  }

  const [services, settings] = await Promise.all([getAllServices(), getSettings()])

  const analysisPeriod = Number(settings.analysis_period ?? 30)
  const thresholds = settings.renewals_low_thresholds || []

  const filtered = services.filter(s => String(s?.customer?.group?.id) === String(groupId))
  const snapshots = filtered.map(s => buildServiceSnapshot(s, thresholds, analysisPeriod))

  const total = snapshots.length
  const expiring = snapshots.filter(s => s.expiringCount > 0)
  const urgent = snapshots.filter(s => s.urgentRenewalsCount > 0)
  const full = snapshots.filter(s => s.isFull)
  const low = snapshots.filter(s => s.isLow && !s.isFull)
  const dontRenew = snapshots.filter(s => s.dontRenew)

  const groupName = snapshots[0]?.groupName || '—'

  const priorities = [
    ...full.map(s => ({
      tipo: 'upgrade',
      priorita: 'alta',
      servizio: s.name,
      cliente: s.customerName,
      msg: 'Spazio esaurito',
    })),
    ...urgent.map(s => ({
      tipo: 'rinnovo',
      priorita: 'alta',
      servizio: s.name,
      cliente: s.customerName,
      msg: `Rinnovo urgente${s.nextRenewalDate ? ` entro ${s.nextRenewalDate}` : ''}`,
    })),
    ...low.map(s => ({
      tipo: 'upgrade',
      priorita: 'media',
      servizio: s.name,
      cliente: s.customerName,
      msg: `Spazio in esaurimento (${s.percent.toFixed(1)}%)`,
    })),
    ...dontRenew.map(s => ({
      tipo: 'verifica',
      priorita: 'media',
      servizio: s.name,
      cliente: s.customerName,
      msg: 'Servizio marcato NON RINNOVARE',
    })),
  ].slice(0, 10)

  res.json({
    groupId,
    groupName,
    analysisPeriod,
    summary: {
      total,
      expiring: expiring.length,
      urgent: urgent.length,
      full: full.length,
      low: low.length,
      dontRenew: dontRenew.length,
    },
    priorities,
    text:
      `Gruppo: ${groupName}\n` +
      `Servizi totali: ${total}\n` +
      `Rinnovi imminenti: ${expiring.length}\n` +
      `Rinnovi urgenti: ${urgent.length}\n` +
      `Spazio esaurito: ${full.length}\n` +
      `Spazio in esaurimento: ${low.length}\n` +
      `Non rinnovare: ${dontRenew.length}`,
  })
}

export async function criticalServices(req, res) {
  const token = req.auth.token
  const [services, settings] = await Promise.all([getAllServices(), getSettings()])

  const analysisPeriod = Number(settings.analysis_period ?? 30)
  const thresholds = settings.renewals_low_thresholds || []

  const items = services
    .map(s => buildServiceSnapshot(s, thresholds, analysisPeriod))
    .flatMap(s => {
      const out = []

      if (s.isFull) {
        out.push({
          tipo: 'upgrade',
          priorita: 'alta',
          servizio: s.name,
          cliente: s.customerName,
          gruppo: s.groupName,
          msg: 'Spazio esaurito',
        })
      }

      if (s.urgentRenewalsCount > 0) {
        out.push({
          tipo: 'rinnovo',
          priorita: 'alta',
          servizio: s.name,
          cliente: s.customerName,
          gruppo: s.groupName,
          msg: `Rinnovo urgente${s.nextRenewalDate ? ` entro ${s.nextRenewalDate}` : ''}`,
        })
      }

      if (s.dontRenew && s.autoRenew) {
        out.push({
          tipo: 'anomalia',
          priorita: 'alta',
          servizio: s.name,
          cliente: s.customerName,
          gruppo: s.groupName,
          msg: 'Servizio con NON RINNOVARE e RINNOVO AUTOMATICO attivi',
        })
      }

      return out
    })

  res.json({
    totale: items.length,
    items: items.slice(0, 50),
  })
}

export async function search(req, res) {
  const token = req.auth.token
  const {q} = req.query

  if (!q || String(q).trim().length < 2) {
    throw httpError(400, 'Parametro q obbligatorio, minimo 2 caratteri')
  }

  const services = await getAllServices()

  const items = services
    .filter(s => {
      return (
        matchesText(s?.name, q) ||
        matchesText(s?.customer?.name, q) ||
        matchesText(s?.customer?.group?.name, q) ||
        matchesText(s?.customer?.businessName, q)
      )
    })
    .map(s => ({
      id: s.id,
      servizio: s?.name || '—',
      cliente: s?.customer?.name || '—',
      gruppo: s?.customer?.group?.name || null,
    }))
    .slice(0, 50)

  res.json({
    totale: items.length,
    items,
  })
}

export async function chatContext(req, res) {
  const token = req.auth.token
  const {customerId, groupId} = req.query

  const [services, settings] = await Promise.all([getAllServices(), getSettings()])

  const analysisPeriod = Number(settings.analysis_period ?? 30)
  const thresholds = settings.renewals_low_thresholds || []

  let filtered = services

  if (customerId) {
    filtered = filtered.filter(s => String(s?.customer?.id) === String(customerId))
  }

  if (groupId) {
    filtered = filtered.filter(s => String(s?.customer?.group?.id) === String(groupId))
  }

  const snapshots = filtered.map(s => buildServiceSnapshot(s, thresholds, analysisPeriod))
  const communications = buildCommunicationsIndex(filtered)

  res.json({
    ...buildChatContextFromSnapshots({
      snapshots,
      customerId,
      groupId,
      analysisPeriod,
      communications,
    }),
  })
}

async function verifyOperationResult(result) {
  return verifyCompletedOperationResult({
    result,
    loadServices: () => getAllServices({force: true}),
    queryCatalog: queryRenewalsCatalog,
    auditPlesk: getPleskRenewalsAudit,
  })
}

export async function chat(req, res) {
  const startedAt = Date.now()
  const {
    message,
    context = {},
    customerId = null,
    groupId = null,
    history = [],
    action = null,
  } = req.body || {}

  const resolvedCustomerId = context.customerId || customerId || null
  const resolvedGroupId = context.groupId || groupId || null
  const resolvedServiceId = context.serviceId || null

  if (action) {
    const fullRenewalResult = hasFullRenewalExecutionProposal(action?.actionId)
      ? await handleFullRenewalExecutionDecision({
          action,
          actorToken: req.auth.token,
        })
      : null

    const supplierRenewalResult = hasSupplierRenewalExecutionProposal(action?.actionId)
      ? await handleSupplierRenewalExecutionDecision({
          action,
          actorToken: req.auth.token,
        })
      : null

    const renewalResult = hasRenewalExecutionProposal(action?.actionId)
      ? await handleRenewalExecutionDecision({
          action,
          actorToken: req.auth.token,
        })
      : null

    const result =
      fullRenewalResult ||
      supplierRenewalResult ||
      renewalResult ||
      (await handleRenewalsActionDecision({
        action,
        actorToken: req.auth.token,
      }))
    const verifiedResult = await verifyOperationResult(result)

    return res.json({
      ...verifiedResult,
      meta: {
        ...(verifiedResult.meta || {}),
        timings: {
          ...(verifiedResult.meta?.timings || {}),
          dataLoadMs: 0,
          totalMs: Date.now() - startedAt,
        },
      },
    })
  }

  if (!message || String(message).trim().length < 2) {
    throw httpError(400, 'message obbligatorio, minimo 2 caratteri')
  }

  const pendingFullRenewalDecisionResult =
    await handlePendingFullRenewalExecutionDecisionMessage({
      message,
      actorToken: req.auth.token,
    })

  if (pendingFullRenewalDecisionResult) {
    const pendingFullRenewalVerifiedResult = await verifyOperationResult(pendingFullRenewalDecisionResult)

    return res.json({
      ...pendingFullRenewalVerifiedResult,
      meta: {
        ...(pendingFullRenewalVerifiedResult.meta || {}),
        timings: {
          ...(pendingFullRenewalVerifiedResult.meta?.timings || {}),
          dataLoadMs: 0,
          totalMs: Date.now() - startedAt,
        },
      },
    })
  }

  const pendingSupplierRenewalDecisionResult =
    await handlePendingSupplierRenewalExecutionDecisionMessage({
      message,
      actorToken: req.auth.token,
    })

  if (pendingSupplierRenewalDecisionResult) {
    const pendingSupplierRenewalVerifiedResult = await verifyOperationResult(pendingSupplierRenewalDecisionResult)

    return res.json({
      ...pendingSupplierRenewalVerifiedResult,
      meta: {
        ...(pendingSupplierRenewalVerifiedResult.meta || {}),
        timings: {
          ...(pendingSupplierRenewalVerifiedResult.meta?.timings || {}),
          dataLoadMs: 0,
          totalMs: Date.now() - startedAt,
        },
      },
    })
  }

  const pendingRenewalDecisionResult = await handlePendingRenewalExecutionDecisionMessage({
    message,
    actorToken: req.auth.token,
  })

  if (pendingRenewalDecisionResult) {
    const pendingRenewalVerifiedResult = await verifyOperationResult(pendingRenewalDecisionResult)

    return res.json({
      ...pendingRenewalVerifiedResult,
      meta: {
        ...(pendingRenewalVerifiedResult.meta || {}),
        timings: {
          ...(pendingRenewalVerifiedResult.meta?.timings || {}),
          dataLoadMs: 0,
          totalMs: Date.now() - startedAt,
        },
      },
    })
  }

  const pendingDecisionResult = await handlePendingRenewalsActionDecisionMessage({
    message,
    actorToken: req.auth.token,
  })

  if (pendingDecisionResult) {
    const pendingVerifiedResult = await verifyOperationResult(pendingDecisionResult)

    return res.json({
      ...pendingVerifiedResult,
      meta: {
        ...(pendingVerifiedResult.meta || {}),
        timings: {
          ...(pendingVerifiedResult.meta?.timings || {}),
          dataLoadMs: 0,
          totalMs: Date.now() - startedAt,
        },
      },
    })
  }


  const pendingEntityMutationDecision =
    await handlePendingEntityMutationDecisionMessage({
      message,
      actorToken: req.auth.token,
      commitFn: commitRenewalsCatalogMutation,
    })

  if (pendingEntityMutationDecision) {
    const pendingEntityMutationVerifiedResult = await verifyOperationResult(pendingEntityMutationDecision)

    return res.json({
      ...pendingEntityMutationVerifiedResult,
      meta: {
        ...(pendingEntityMutationVerifiedResult.meta || {}),
        timings: {
          ...(pendingEntityMutationVerifiedResult.meta?.timings || {}),
          dataLoadMs: 0,
          totalMs: Date.now() - startedAt,
        },
      },
    })
  }

  const openEmailGenerationRequest = await planOpenEmailGenerationAction({
    message,
  })

  if (
    !openEmailGenerationRequest &&
    hasPendingOpenEmailGenerationClarification({actorToken: req.auth.token})
  ) {
    const pendingAppActionResult = handlePendingOpenEmailGenerationClarification({
      message,
      actorToken: req.auth.token,
    })

    if (pendingAppActionResult) {
      return res.json({
        ...pendingAppActionResult,
        meta: {
          ...(pendingAppActionResult.meta || {}),
          timings: {
            ...(pendingAppActionResult.meta?.timings || {}),
            dataLoadMs: 0,
            totalMs: Date.now() - startedAt,
          },
        },
      })
    }
  }

  if (openEmailGenerationRequest) {
    const dataLoadStartedAt = Date.now()
    const [services, settings] = await Promise.all([getAllServices(), getSettings()])
    const dataLoadMs = Date.now() - dataLoadStartedAt

    const appActionResult = buildOpenEmailGenerationAction({
      request: openEmailGenerationRequest,
      services,
      settings,
      history: Array.isArray(history) ? history : [],
      scope: {
        customerId: resolvedCustomerId,
        groupId: resolvedGroupId,
        serviceId: resolvedServiceId,
      },
      actorToken: req.auth.token,
    })

    return res.json({
      ...appActionResult,
      meta: {
        ...(appActionResult.meta || {}),
        timings: {
          ...(appActionResult.meta?.timings || {}),
          dataLoadMs,
          totalMs: Date.now() - startedAt,
        },
        servicesCount: Array.isArray(services) ? services.length : null,
      },
    })
  }

  const communicationDraftRequest = await planCommunicationDraftRequest({
    message,
  })

  if (
    !communicationDraftRequest &&
    hasPendingCommunicationDraftClarification({actorToken: req.auth.token})
  ) {
    const dataLoadStartedAt = Date.now()
    const [services, settings] = await Promise.all([getAllServices(), getSettings()])
    const dataLoadMs = Date.now() - dataLoadStartedAt

    const clarificationResult = await handlePendingCommunicationDraftClarification({
      message,
      services,
      settings,
      history: Array.isArray(history) ? history : [],
      scope: {
        customerId: resolvedCustomerId,
        groupId: resolvedGroupId,
        serviceId: resolvedServiceId,
      },
      actorToken: req.auth.token,
    })

    if (clarificationResult) {
      return res.json({
        ...clarificationResult,
        meta: {
          ...(clarificationResult.meta || {}),
          timings: {
            ...(clarificationResult.meta?.timings || {}),
            dataLoadMs,
            totalMs: Date.now() - startedAt,
          },
          servicesCount: Array.isArray(services) ? services.length : null,
        },
      })
    }
  }

  if (communicationDraftRequest) {
    const dataLoadStartedAt = Date.now()
    const [services, settings] = await Promise.all([getAllServices(), getSettings()])
    const dataLoadMs = Date.now() - dataLoadStartedAt

    const draftResult = await buildCommunicationDraftPreview({
      request: communicationDraftRequest,
      services,
      settings,
      history: Array.isArray(history) ? history : [],
      scope: {
        customerId: resolvedCustomerId,
        groupId: resolvedGroupId,
        serviceId: resolvedServiceId,
      },
      actorToken: req.auth.token,
    })

    return res.json({
      ...draftResult,
      meta: {
        ...(draftResult.meta || {}),
        timings: {
          ...(draftResult.meta?.timings || {}),
          dataLoadMs,
          totalMs: Date.now() - startedAt,
        },
        servicesCount: Array.isArray(services) ? services.length : null,
      },
    })
  }

  if (isGenericOperationUndoRequest(message)) {
    const latestOperation = pickLatestCompletedOperation([
      {
        kind: 'full-renewal',
        context: getRecentCompletedFullRenewalContext({actorToken: req.auth.token}),
      },
      {
        kind: 'supplier-renewal',
        context: getRecentCompletedSupplierRenewalContext({actorToken: req.auth.token}),
      },
      {
        kind: 'customer-renewal',
        context: getRecentCompletedRenewalContext({actorToken: req.auth.token}),
      },
      {
        kind: 'service-action',
        context: getRecentCompletedRenewalsActionContext({actorToken: req.auth.token}),
      },
      {
        kind: 'entity-mutation',
        context: getRecentCompletedEntityMutationContext({actorToken: req.auth.token}),
      },
    ])

    if (!latestOperation) {
      return res.json({
        ok: true,
        intent: 'action-error',
        source: 'tool-fast',
        reply: 'Non ho un’operazione recente da annullare.',
        data: {
          type: 'action-error',
          error: {code: 'recent-operation-undo-missing'},
        },
        meta: {
          timings: {
            dataLoadMs: 0,
            totalMs: Date.now() - startedAt,
          },
        },
      })
    }

    if (latestOperation.kind === 'entity-mutation') {
      const undoResult = await buildRecentEntityMutationUndoProposal({
        actorToken: req.auth.token,
        previewFn: previewRenewalsCatalogMutation,
      })

      return res.json({
        ...undoResult,
        meta: {
          ...(undoResult.meta || {}),
          undoSource: 'latest-completed-operation',
          latestOperationKind: latestOperation.kind,
          timings: {
            ...(undoResult.meta?.timings || {}),
            dataLoadMs: 0,
            totalMs: Date.now() - startedAt,
          },
        },
      })
    }

    if (latestOperation.kind === 'service-action') {
      const dataLoadStartedAt = Date.now()
      const services = await getAllServices()
      const dataLoadMs = Date.now() - dataLoadStartedAt
      const undoResult = buildRecentRenewalsActionUndoPreview({
        services,
        actorToken: req.auth.token,
      })

      return res.json({
        ...undoResult,
        meta: {
          ...(undoResult.meta || {}),
          undoSource: 'latest-completed-operation',
          latestOperationKind: latestOperation.kind,
          timings: {
            ...(undoResult.meta?.timings || {}),
            dataLoadMs,
            totalMs: Date.now() - startedAt,
          },
          servicesCount: Array.isArray(services) ? services.length : null,
        },
      })
    }

    const undoResult =
      latestOperation.kind === 'full-renewal'
        ? buildRecentCompletedFullRenewalUndoReply({actorToken: req.auth.token})
        : latestOperation.kind === 'supplier-renewal'
          ? buildRecentCompletedSupplierRenewalUndoReply({actorToken: req.auth.token})
          : buildRecentCompletedRenewalUndoReply({actorToken: req.auth.token})

    return res.json({
      ...undoResult,
      meta: {
        ...(undoResult.meta || {}),
        undoSource: 'latest-completed-operation',
        latestOperationKind: latestOperation.kind,
        timings: {
          ...(undoResult.meta?.timings || {}),
          dataLoadMs: 0,
          totalMs: Date.now() - startedAt,
        },
      },
    })
  }

  const isFullRenewalUndo = isRecentCompletedFullRenewalUndoRequest(message, {
    actorToken: req.auth.token,
  })
  const isSupplierRenewalUndo = isRecentCompletedSupplierRenewalUndoRequest(message, {
    actorToken: req.auth.token,
  })
  const isCustomerRenewalUndo = isRecentCompletedRenewalUndoRequest(message, {
    actorToken: req.auth.token,
  })

  if (isFullRenewalUndo || isSupplierRenewalUndo || isCustomerRenewalUndo) {
    const fullContext = getRecentCompletedFullRenewalContext({
      actorToken: req.auth.token,
    })
    const supplierContext = getRecentCompletedSupplierRenewalContext({
      actorToken: req.auth.token,
    })
    const customerContext = getRecentCompletedRenewalContext({
      actorToken: req.auth.token,
    })

    const latest = [
      {kind: 'full', context: fullContext},
      {kind: 'supplier', context: supplierContext},
      {kind: 'customer', context: customerContext},
    ]
      .filter(item => item.context)
      .sort(
        (a, b) =>
          Number(b.context?.completedAt || 0) - Number(a.context?.completedAt || 0)
      )[0]

    const result =
      latest?.kind === 'full'
        ? buildRecentCompletedFullRenewalUndoReply({actorToken: req.auth.token})
        : latest?.kind === 'supplier'
          ? buildRecentCompletedSupplierRenewalUndoReply({actorToken: req.auth.token})
          : buildRecentCompletedRenewalUndoReply({actorToken: req.auth.token})

    return res.json({
      ...result,
      meta: {
        ...(result.meta || {}),
        timings: {
          ...(result.meta?.timings || {}),
          dataLoadMs: 0,
          totalMs: Date.now() - startedAt,
        },
      },
    })
  }

  if (isRecentEntityMutationUndoRequest(message)) {
    const undoResult = await buildRecentEntityMutationUndoProposal({
      actorToken: req.auth.token,
      previewFn: previewRenewalsCatalogMutation,
    })

    return res.json({
      ...undoResult,
      meta: {
        ...(undoResult.meta || {}),
        timings: {
          ...(undoResult.meta?.timings || {}),
          dataLoadMs: 0,
          totalMs: Date.now() - startedAt,
        },
      },
    })
  }

  if (isRecentRenewalsActionUndoRequest(message)) {
    const dataLoadStartedAt = Date.now()

    const services = await getAllServices()

    const dataLoadMs = Date.now() - dataLoadStartedAt

    const undoResult = buildRecentRenewalsActionUndoPreview({
      services,
      actorToken: req.auth.token,
    })

    return res.json({
      ...undoResult,

      meta: {
        ...(undoResult.meta || {}),

        timings: {
          ...(undoResult.meta?.timings || {}),

          dataLoadMs,
          totalMs: Date.now() - startedAt,
        },

        servicesCount: Array.isArray(services) ? services.length : null,
      },
    })
  }

  const fullRenewalExecutionRequest = parseFullRenewalExecutionRequest(message)

  if (
    !fullRenewalExecutionRequest &&
    hasPendingFullRenewalExecutionClarification({
      actorToken: req.auth.token,
    })
  ) {
    const dataLoadStartedAt = Date.now()
    const services = await getAllServices()
    const dataLoadMs = Date.now() - dataLoadStartedAt

    const clarificationResult = await handlePendingFullRenewalExecutionClarification({
      message,
      services,
      actorToken: req.auth.token,
    })

    if (clarificationResult) {
      return res.json({
        ...clarificationResult,
        meta: {
          ...(clarificationResult.meta || {}),
          timings: {
            ...(clarificationResult.meta?.timings || {}),
            dataLoadMs,
            totalMs: Date.now() - startedAt,
          },
          servicesCount: Array.isArray(services) ? services.length : null,
        },
      })
    }
  }

  if (fullRenewalExecutionRequest) {
    const dataLoadStartedAt = Date.now()
    const [services, settings] = await Promise.all([getAllServices(), getSettings()])
    const dataLoadMs = Date.now() - dataLoadStartedAt
    const recentActionTarget = getRecentRenewalsActionTarget({
      actorToken: req.auth.token,
    })
    const recentFullRenewalTarget = getRecentCompletedFullRenewalTarget({
      actorToken: req.auth.token,
    })
    const recentCustomerRenewalTarget = getRecentCompletedRenewalTarget({
      actorToken: req.auth.token,
    })
    const recentSupplierRenewalTarget = getRecentCompletedSupplierRenewalTarget({
      actorToken: req.auth.token,
    })

    const result = await handleFullRenewalExecutionRequest({
      request: fullRenewalExecutionRequest,
      services,
      settings,
      history: Array.isArray(history) ? history : [],
      scope: {
        customerId: resolvedCustomerId,
        groupId: resolvedGroupId,
        serviceId: resolvedServiceId,
      },
      actorToken: req.auth.token,
      recentServiceId:
        recentFullRenewalTarget?.id ||
        recentCustomerRenewalTarget?.id ||
        recentSupplierRenewalTarget?.id ||
        recentActionTarget?.id ||
        null,
    })

    return res.json({
      ...result,
      meta: {
        ...(result.meta || {}),
        timings: {
          ...(result.meta?.timings || {}),
          dataLoadMs,
          totalMs: Date.now() - startedAt,
        },
        servicesCount: Array.isArray(services) ? services.length : null,
      },
    })
  }

  const supplierRenewalExecutionRequest = parseSupplierRenewalExecutionRequest(message)

  if (
    !supplierRenewalExecutionRequest &&
    hasPendingSupplierRenewalExecutionClarification({
      actorToken: req.auth.token,
    })
  ) {
    const dataLoadStartedAt = Date.now()
    const services = await getAllServices()
    const dataLoadMs = Date.now() - dataLoadStartedAt

    const clarificationResult = await handlePendingSupplierRenewalExecutionClarification({
      message,
      services,
      actorToken: req.auth.token,
    })

    if (clarificationResult) {
      return res.json({
        ...clarificationResult,
        meta: {
          ...(clarificationResult.meta || {}),
          timings: {
            ...(clarificationResult.meta?.timings || {}),
            dataLoadMs,
            totalMs: Date.now() - startedAt,
          },
          servicesCount: Array.isArray(services) ? services.length : null,
        },
      })
    }
  }

  if (supplierRenewalExecutionRequest) {
    const dataLoadStartedAt = Date.now()
    const [services, settings] = await Promise.all([getAllServices(), getSettings()])
    const dataLoadMs = Date.now() - dataLoadStartedAt
    const recentActionTarget = getRecentRenewalsActionTarget({
      actorToken: req.auth.token,
    })
    const recentCompletedRenewalTarget = getRecentCompletedRenewalTarget({
      actorToken: req.auth.token,
    })
    const recentCompletedSupplierRenewalTarget = getRecentCompletedSupplierRenewalTarget({
      actorToken: req.auth.token,
    })

    const result = await handleSupplierRenewalExecutionRequest({
      request: supplierRenewalExecutionRequest,
      services,
      settings,
      history: Array.isArray(history) ? history : [],
      scope: {
        customerId: resolvedCustomerId,
        groupId: resolvedGroupId,
        serviceId: resolvedServiceId,
      },
      actorToken: req.auth.token,
      recentServiceId:
        recentCompletedSupplierRenewalTarget?.id ||
        recentCompletedRenewalTarget?.id ||
        recentActionTarget?.id ||
        null,
    })

    return res.json({
      ...result,
      meta: {
        ...(result.meta || {}),
        timings: {
          ...(result.meta?.timings || {}),
          dataLoadMs,
          totalMs: Date.now() - startedAt,
        },
        servicesCount: Array.isArray(services) ? services.length : null,
      },
    })
  }

  const fullRenewalPreviewRequest = parseFullRenewalPreviewRequest(message)

  if (
    !fullRenewalPreviewRequest &&
    hasPendingFullRenewalPreviewClarification({
      actorToken: req.auth.token,
    })
  ) {
    const dataLoadStartedAt = Date.now()
    const services = await getAllServices()
    const dataLoadMs = Date.now() - dataLoadStartedAt

    const clarificationResult = await handlePendingFullRenewalPreviewClarification({
      message,
      services,
      actorToken: req.auth.token,
    })

    if (clarificationResult) {
      return res.json({
        ...clarificationResult,
        meta: {
          ...(clarificationResult.meta || {}),
          timings: {
            ...(clarificationResult.meta?.timings || {}),
            dataLoadMs,
            totalMs: Date.now() - startedAt,
          },
          servicesCount: Array.isArray(services) ? services.length : null,
        },
      })
    }
  }

  if (fullRenewalPreviewRequest) {
    const dataLoadStartedAt = Date.now()
    const [services, settings] = await Promise.all([getAllServices(), getSettings()])
    const dataLoadMs = Date.now() - dataLoadStartedAt
    const recentActionTarget = getRecentRenewalsActionTarget({
      actorToken: req.auth.token,
    })
    const recentFullRenewalTarget = getRecentCompletedFullRenewalTarget({
      actorToken: req.auth.token,
    })
    const recentCustomerRenewalTarget = getRecentCompletedRenewalTarget({
      actorToken: req.auth.token,
    })
    const recentSupplierRenewalTarget = getRecentCompletedSupplierRenewalTarget({
      actorToken: req.auth.token,
    })

    const result = await handleFullRenewalPreviewRequest({
      request: fullRenewalPreviewRequest,
      services,
      settings,
      history: Array.isArray(history) ? history : [],
      scope: {
        customerId: resolvedCustomerId,
        groupId: resolvedGroupId,
        serviceId: resolvedServiceId,
      },
      actorToken: req.auth.token,
      recentServiceId:
        recentFullRenewalTarget?.id ||
        recentCustomerRenewalTarget?.id ||
        recentSupplierRenewalTarget?.id ||
        recentActionTarget?.id ||
        null,
    })

    return res.json({
      ...result,
      meta: {
        ...(result.meta || {}),
        timings: {
          ...(result.meta?.timings || {}),
          dataLoadMs,
          totalMs: Date.now() - startedAt,
        },
        servicesCount: Array.isArray(services) ? services.length : null,
      },
    })
  }

  const supplierRenewalPreviewRequest = parseSupplierRenewalPreviewRequest(message)

  if (
    !supplierRenewalPreviewRequest &&
    hasPendingSupplierRenewalPreviewClarification({
      actorToken: req.auth.token,
    })
  ) {
    const dataLoadStartedAt = Date.now()
    const services = await getAllServices()
    const dataLoadMs = Date.now() - dataLoadStartedAt

    const clarificationResult = await handlePendingSupplierRenewalPreviewClarification({
      message,
      services,
      actorToken: req.auth.token,
    })

    if (clarificationResult) {
      return res.json({
        ...clarificationResult,
        meta: {
          ...(clarificationResult.meta || {}),
          timings: {
            ...(clarificationResult.meta?.timings || {}),
            dataLoadMs,
            totalMs: Date.now() - startedAt,
          },
          servicesCount: Array.isArray(services) ? services.length : null,
        },
      })
    }
  }

  if (supplierRenewalPreviewRequest) {
    const dataLoadStartedAt = Date.now()
    const [services, settings] = await Promise.all([getAllServices(), getSettings()])
    const dataLoadMs = Date.now() - dataLoadStartedAt
    const recentActionTarget = getRecentRenewalsActionTarget({
      actorToken: req.auth.token,
    })
    const recentCompletedRenewalTarget = getRecentCompletedRenewalTarget({
      actorToken: req.auth.token,
    })

    const result = await handleSupplierRenewalPreviewRequest({
      request: supplierRenewalPreviewRequest,
      services,
      settings,
      history: Array.isArray(history) ? history : [],
      scope: {
        customerId: resolvedCustomerId,
        groupId: resolvedGroupId,
        serviceId: resolvedServiceId,
      },
      actorToken: req.auth.token,
      recentServiceId: recentCompletedRenewalTarget?.id || recentActionTarget?.id || null,
    })

    return res.json({
      ...result,
      meta: {
        ...(result.meta || {}),
        timings: {
          ...(result.meta?.timings || {}),
          dataLoadMs,
          totalMs: Date.now() - startedAt,
        },
        servicesCount: Array.isArray(services) ? services.length : null,
      },
    })
  }

  const renewalExecutionRequest = parseRenewalExecutionRequest(message)

  if (
    !renewalExecutionRequest &&
    hasPendingRenewalExecutionClarification({
      actorToken: req.auth.token,
    })
  ) {
    const dataLoadStartedAt = Date.now()
    const services = await getAllServices()
    const dataLoadMs = Date.now() - dataLoadStartedAt

    const clarificationResult = await handlePendingRenewalExecutionClarification({
      message,
      services,
      actorToken: req.auth.token,
    })

    if (clarificationResult) {
      return res.json({
        ...clarificationResult,
        meta: {
          ...(clarificationResult.meta || {}),
          timings: {
            ...(clarificationResult.meta?.timings || {}),
            dataLoadMs,
            totalMs: Date.now() - startedAt,
          },
          servicesCount: Array.isArray(services) ? services.length : null,
        },
      })
    }
  }

  if (renewalExecutionRequest) {
    const dataLoadStartedAt = Date.now()
    const [services, settings] = await Promise.all([getAllServices(), getSettings()])
    const dataLoadMs = Date.now() - dataLoadStartedAt
    const recentActionTarget = getRecentRenewalsActionTarget({
      actorToken: req.auth.token,
    })

    const result = await handleRenewalExecutionRequest({
      request: renewalExecutionRequest,
      services,
      settings,
      history: Array.isArray(history) ? history : [],
      scope: {
        customerId: resolvedCustomerId,
        groupId: resolvedGroupId,
        serviceId: resolvedServiceId,
      },
      actorToken: req.auth.token,
      recentServiceId: recentActionTarget?.id || null,
    })

    return res.json({
      ...result,
      meta: {
        ...(result.meta || {}),
        timings: {
          ...(result.meta?.timings || {}),
          dataLoadMs,
          totalMs: Date.now() - startedAt,
        },
        servicesCount: Array.isArray(services) ? services.length : null,
      },
    })
  }

  const actionRequest =
    parseServiceAuthCodeAction(message) ||
    parseServiceInvoiceDateAction(message) ||
    parseCopySupplierExpiryToCustomerAction(message) ||
    parseServiceSubscriptionEndDateAction(message) ||
    parseServicePleskPlanSyncAction(message) ||
    parseServiceTransferTargetAction(message) ||
    parseServiceFlagAction(message)

  if (
    !actionRequest &&
    hasPendingRenewalsActionClarification({
      actorToken: req.auth.token,
    })
  ) {
    const dataLoadStartedAt = Date.now()

    const [services, settings] = await Promise.all([getAllServices(), getSettings()])

    const dataLoadMs = Date.now() - dataLoadStartedAt

    const clarificationResult = handlePendingRenewalsActionClarification({
      message,
      services,
      settings,
      history: Array.isArray(history) ? history : [],
      scope: {
        customerId: resolvedCustomerId,
        groupId: resolvedGroupId,
        serviceId: resolvedServiceId,
      },
      actorToken: req.auth.token,
    })

    if (clarificationResult) {
      return res.json({
        ...clarificationResult,
        meta: {
          ...(clarificationResult.meta || {}),
          timings: {
            ...(clarificationResult.meta?.timings || {}),
            dataLoadMs,
            totalMs: Date.now() - startedAt,
          },
          servicesCount: Array.isArray(services) ? services.length : null,
        },
      })
    }
  }

  if (actionRequest) {
    const dataLoadStartedAt = Date.now()
    const needsProviders = actionRequest.type === 'renewals-transfer-target-request'

    const [services, settings, serviceOptions] = await Promise.all([
      getAllServices(),
      getSettings(),
      needsProviders ? getServiceOptions() : Promise.resolve({providers: []}),
    ])

    const dataLoadMs = Date.now() - dataLoadStartedAt

    const previewArgs = {
      request: actionRequest,
      services,
      providers: serviceOptions.providers || [],
      settings,
      history: Array.isArray(history) ? history : [],
      scope: {
        customerId: resolvedCustomerId,
        groupId: resolvedGroupId,
        serviceId: resolvedServiceId,
      },
      actorToken: req.auth.token,
    }

    const result =
      actionRequest.type === 'renewals-transfer-target-request'
        ? buildServiceTransferTargetActionPreview(previewArgs)
        : actionRequest.type === 'renewals-invoice-date-request'
          ? buildServiceInvoiceDateActionPreview(previewArgs)
          : actionRequest.type === 'renewals-copy-supplier-expiry-to-customer-request'
            ? buildCopySupplierExpiryToCustomerActionPreview(previewArgs)
            : actionRequest.type === 'renewals-subscription-end-date-request'
              ? buildServiceSubscriptionEndDateActionPreview(previewArgs)
              : actionRequest.type === 'renewals-plesk-plan-sync-request'
              ? buildServicePleskPlanSyncActionPreview(previewArgs)
              : actionRequest.type === 'renewals-auth-code-request'
                ? buildServiceAuthCodeActionPreview(previewArgs)
                : buildServiceFlagActionPreview(previewArgs)

    return res.json({
      ...result,
      meta: {
        ...(result.meta || {}),
        timings: {
          ...(result.meta?.timings || {}),
          dataLoadMs,
          totalMs: Date.now() - startedAt,
        },
        servicesCount: Array.isArray(services) ? services.length : null,
      },
    })
  }

  const renewalPreviewRequest = parseRenewalPreviewRequest(message)

  if (
    !renewalPreviewRequest &&
    hasPendingRenewalPreviewClarification({
      actorToken: req.auth.token,
    })
  ) {
    const dataLoadStartedAt = Date.now()
    const services = await getAllServices()
    const dataLoadMs = Date.now() - dataLoadStartedAt

    const pendingPreviewResult = await handlePendingRenewalPreviewClarification({
      message,
      services,
      actorToken: req.auth.token,
    })

    if (pendingPreviewResult) {
      return res.json({
        ...pendingPreviewResult,
        meta: {
          ...(pendingPreviewResult.meta || {}),
          timings: {
            ...(pendingPreviewResult.meta?.timings || {}),
            dataLoadMs,
            totalMs: Date.now() - startedAt,
          },
          servicesCount: Array.isArray(services) ? services.length : null,
        },
      })
    }
  }

  if (renewalPreviewRequest) {
    const dataLoadStartedAt = Date.now()
    const [services, settings] = await Promise.all([getAllServices(), getSettings()])
    const dataLoadMs = Date.now() - dataLoadStartedAt
    const recentActionTarget = getRecentRenewalsActionTarget({
      actorToken: req.auth.token,
    })

    const previewResult = await handleRenewalPreviewRequest({
      request: renewalPreviewRequest,
      services,
      settings,
      history: Array.isArray(history) ? history : [],
      scope: {
        customerId: resolvedCustomerId,
        groupId: resolvedGroupId,
        serviceId: resolvedServiceId,
      },
      actorToken: req.auth.token,
      recentServiceId: recentActionTarget?.id || null,
    })

    return res.json({
      ...previewResult,
      meta: {
        ...(previewResult.meta || {}),
        timings: {
          ...(previewResult.meta?.timings || {}),
          dataLoadMs,
          totalMs: Date.now() - startedAt,
        },
        servicesCount: Array.isArray(services) ? services.length : null,
      },
    })
  }

  const diagnosticRequest =
    parsePleskAuditRequest(message) ||
    parseServiceSubscriptionExpiryRequest(message) ||
    parseServiceHttpCheckRequest(message)

  if (
    !diagnosticRequest &&
    hasPendingRenewalsDiagnosticClarification({
      actorToken: req.auth.token,
    })
  ) {
    const dataLoadStartedAt = Date.now()
    const [services, settings] = await Promise.all([getAllServices(), getSettings()])
    const dataLoadMs = Date.now() - dataLoadStartedAt
    const recentActionTarget = getRecentRenewalsActionTarget({
      actorToken: req.auth.token,
    })

    const pendingDiagnosticResult = await handlePendingRenewalsDiagnosticClarification({
      message,
      services,
      settings,
      history: Array.isArray(history) ? history : [],
      scope: {
        customerId: resolvedCustomerId,
        groupId: resolvedGroupId,
        serviceId: resolvedServiceId,
      },
      actorToken: req.auth.token,
      recentServiceId: recentActionTarget?.id || null,
    })

    if (pendingDiagnosticResult) {
      return res.json({
        ...pendingDiagnosticResult,
        meta: {
          ...(pendingDiagnosticResult.meta || {}),
          timings: {
            ...(pendingDiagnosticResult.meta?.timings || {}),
            dataLoadMs,
            totalMs: Date.now() - startedAt,
          },
          servicesCount: Array.isArray(services) ? services.length : null,
        },
      })
    }
  }

  if (diagnosticRequest) {
    const dataLoadStartedAt = Date.now()
    const [services, settings] = await Promise.all([getAllServices(), getSettings()])
    const dataLoadMs = Date.now() - dataLoadStartedAt
    const recentActionTarget = getRecentRenewalsActionTarget({
      actorToken: req.auth.token,
    })

    const diagnosticArgs = {
      request: diagnosticRequest,
      services,
      settings,
      history: Array.isArray(history) ? history : [],
      scope: {
        customerId: resolvedCustomerId,
        groupId: resolvedGroupId,
        serviceId: resolvedServiceId,
      },
      actorToken: req.auth.token,
      recentServiceId: recentActionTarget?.id || null,
    }

    const result =
      diagnosticRequest.type === 'renewals-plesk-audit-request'
        ? await handlePleskAuditRequest(diagnosticArgs)
        : diagnosticRequest.type === 'renewals-subscription-expiry-request'
          ? await handleServiceSubscriptionExpiryRequest(diagnosticArgs)
          : await handleServiceHttpCheckRequest(diagnosticArgs)

    return res.json({
      ...result,
      meta: {
        ...(result.meta || {}),
        timings: {
          ...(result.meta?.timings || {}),
          dataLoadMs,
          totalMs: Date.now() - startedAt,
        },
        servicesCount: Array.isArray(services) ? services.length : null,
      },
    })
  }

  const entityMutationPlan = await planEntityMutationRequest({
    message,
    history: Array.isArray(history) ? history : [],
  })

  if (entityMutationPlan) {
    const dataLoadStartedAt = Date.now()
    const [services, serviceOptions] = await Promise.all([
      getAllServices(),
      getServiceOptions(),
    ])
    const dataLoadMs = Date.now() - dataLoadStartedAt

    const mutationResult = await buildEntityMutationProposal({
      plan: entityMutationPlan,
      services,
      options: serviceOptions,
      actorToken: req.auth.token,
      queryCatalog: queryRenewalsCatalog,
      previewFn: previewRenewalsCatalogMutation,
    })

    return res.json({
      ...mutationResult,
      meta: {
        ...(mutationResult.meta || {}),
        entity: entityMutationPlan.entity,
        operation: 'update',
        timings: {
          ...(mutationResult.meta?.timings || {}),
          dataLoadMs,
          totalMs: Date.now() - startedAt,
        },
        servicesCount: Array.isArray(services) ? services.length : null,
      },
    })
  }

  let resolvedDetailTarget = null
  let resolvedServiceDetailMessage = null
  let skipReadQueryForServiceTarget = false
  let targetResolutionMs = 0

  const deterministicReadUtterance = parseReadQueryUtterance(message)
  const pendingReadTargetSelection = resolvePendingReadQueryTargetClarification({
    actorToken: req.auth.token,
    message,
    readUtterance: deterministicReadUtterance,
  })

  if (pendingReadTargetSelection.status === 'resolved') {
    const pendingResolution = pendingReadTargetSelection.resolution

    if (pendingResolution.entityId === 'services') {
      clearRememberedReadQueryContext({actorToken: req.auth.token})
      skipReadQueryForServiceTarget = true
      resolvedServiceDetailMessage = `dettagli di ${pendingResolution.name || pendingResolution.target}`
    } else {
      resolvedDetailTarget = pendingResolution
    }
  } else if (pendingReadTargetSelection.status === 'invalid') {
    const pending = pendingReadTargetSelection.pending

    return res.json({
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildReadQueryTargetClarification({
        status: 'ambiguous',
        target: pending?.target || null,
        candidates: pending?.candidates || [],
      }),
      data: {
        type: 'clarification',
        reason: 'read-query-target-selection-invalid',
        target: pending?.target || null,
        candidates: pending?.candidates || [],
      },
      meta: {
        moduleId: 'facile.renewals',
        intent: 'clarification',
        targetResolution: 'pending-invalid',
        timings: {
          totalMs: Date.now() - startedAt,
        },
      },
    })
  }

  const readUtterance =
    deterministicReadUtterance ||
    (await interpretReadQueryUtterance({
      message,
      history: Array.isArray(history) ? history : [],
    }))

  if (
    !resolvedDetailTarget &&
    shouldResolveReadQueryDetailTarget(message, readUtterance)
  ) {
    const targetResolutionStartedAt = Date.now()
    const [resolutionServices, resolutionOptions] = await Promise.all([
      getAllServices(),
      getServiceOptions(),
    ])
    const resolution = await resolveReadQueryDetailTarget({
      message,
      services: resolutionServices,
      options: resolutionOptions,
      queryCatalog: queryRenewalsCatalog,
      readUtterance,
    })
    targetResolutionMs = Date.now() - targetResolutionStartedAt

    if (resolution.status === 'ambiguous' || resolution.status === 'not-found') {
      if (resolution.status === 'ambiguous') {
        rememberReadQueryTargetClarification({
          actorToken: req.auth.token,
          resolution,
        })
      } else {
        clearPendingReadQueryTargetClarification({actorToken: req.auth.token})
      }

      return res.json({
        ok: true,
        intent: 'clarification',
        source: 'tool-fast',
        reply: buildReadQueryTargetClarification(resolution),
        data: {
          type: 'clarification',
          reason: `read-query-target-${resolution.status}`,
          target: resolution.target || null,
          candidates: resolution.candidates || [],
        },
        meta: {
          moduleId: 'facile.renewals',
          intent: 'clarification',
          targetResolution: resolution.status,
          timings: {
            targetResolutionMs,
            totalMs: Date.now() - startedAt,
          },
          servicesCount: Array.isArray(resolutionServices)
            ? resolutionServices.length
            : null,
        },
      })
    }

    if (resolution.status === 'resolved') {
      clearPendingReadQueryTargetClarification({actorToken: req.auth.token})

      if (resolution.entityId === 'services') {
        clearRememberedReadQueryContext({actorToken: req.auth.token})
        skipReadQueryForServiceTarget = true
        resolvedServiceDetailMessage = `dettagli di ${resolution.name || resolution.target}`
      } else {
        resolvedDetailTarget = resolution
      }
    }
  }

  const readQueryPlan = skipReadQueryForServiceTarget
    ? null
    : await planReadQuery({
        message,
        history: Array.isArray(history) ? history : [],
        actorToken: req.auth.token,
        resolvedDetailTarget,
        readUtterance,
      })

  if (readQueryPlan) {
    const dataLoadStartedAt = Date.now()
    const useCatalog = canExecuteReadQueryFromCatalog(readQueryPlan)
    let catalogError = null

    const catalogPromise = useCatalog
      ? queryRenewalsCatalog(readQueryPlan).catch(error => {
          catalogError = error
          console.warn('[renewals-catalog] fallback to operational data:', error.message)
          return null
        })
      : Promise.resolve(null)

    const [catalogResult, services, serviceOptions] = await Promise.all([
      catalogPromise,
      getAllServices(),
      getServiceOptions(),
    ])
    const dataLoadMs = Date.now() - dataLoadStartedAt
    const readResult = executeReadQuery({
      plan: readQueryPlan,
      services,
      options: serviceOptions,
      catalogResult,
    })

    rememberReadQueryContext({
      actorToken: req.auth.token,
      plan: readQueryPlan,
      result: readResult,
    })

    return res.json({
      ok: true,
      intent: 'read-query',
      source: readQueryPlan.source === 'semantic' ? 'tool-semantic' : 'tool-fast',
      reply: buildReadQueryReply(readResult),
      data: readResult,
      meta: {
        moduleId: 'facile.renewals',
        intent: 'read-query',
        entity: readQueryPlan.entity,
        operation: readQueryPlan.operation,
        plannerSource: readQueryPlan.source,
        readUtteranceSource: readUtterance?.source || null,
        dataSource: readResult.dataSource || null,
        catalogRequested: useCatalog,
        catalogFallback: Boolean(useCatalog && !catalogResult),
        catalogError: catalogError?.message || null,
        timings: {
          targetResolutionMs,
          dataLoadMs,
          totalMs: Date.now() - startedAt,
        },
        servicesCount: Array.isArray(services) ? services.length : null,
      },
    })
  }

  const downstreamMessage = resolvedServiceDetailMessage || message

  const directPlan = planChatRequest({
    message: downstreamMessage,
    context: {
      ...context,
      customerId: resolvedCustomerId,
      groupId: resolvedGroupId,
      serviceId: resolvedServiceId,
    },
  })

  if (directPlan.type === 'direct') {
    return res.json({
      ok: true,
      intent: directPlan.intent,
      source: 'direct',
      reply: directPlan.reply,
      data: null,
      meta: {
        moduleId: 'facile.renewals',
        source: 'direct',
        intent: directPlan.intent,
        planType: directPlan.type,
        timings: {
          dataLoadMs: 0,
          totalMs: Date.now() - startedAt,
        },
      },
    })
  }

  const dataLoadStartedAt = Date.now()
  const [services, settings] = await Promise.all([getAllServices(), getSettings()])

  const analysisPeriod = Number(settings.analysis_period ?? 30)

  const panelCounts = await getPanelCounts({
    analysisPeriod,
    customerId: resolvedCustomerId,
    groupId: resolvedGroupId,
  })

  const dataLoadMs = Date.now() - dataLoadStartedAt

  const result = await handleRenewalsChat({
    message: downstreamMessage,
    customerId: resolvedCustomerId,
    groupId: resolvedGroupId,
    serviceId: resolvedServiceId,
    context,
    history: Array.isArray(history) ? history : [],
    services,
    settings,
    panelCounts,
    debug: {
      dataLoadMs,
      servicesCount: Array.isArray(services) ? services.length : null,
    },
  })

  res.json({
    ...result,
    meta: {
      ...(result.meta || {}),
      timings: {
        ...(result.meta?.timings || {}),
        dataLoadMs,
        totalMs: Date.now() - startedAt,
      },
      servicesCount: Array.isArray(services) ? services.length : null,
    },
  })
}
