import {getAllServices, getSettings, getPanelCounts, getServiceOptions} from './service.js'
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
import {buildChatContextFromSnapshots} from './context.js'
import {handleRenewalsChat} from './chat.js'
import {httpError} from '../../../utils/httpError.js'
import {buildTodoPayloadFromServices} from './todos.js'
import {planChatRequest} from '../../../core/planner/chatPlanner.js'
import {
  buildCopySupplierExpiryToCustomerActionPreview,
  buildRecentRenewalsActionUndoPreview,
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
    const result = await handleRenewalsActionDecision({
      action,
      actorToken: req.auth.token,
    })

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

  if (!message || String(message).trim().length < 2) {
    throw httpError(400, 'message obbligatorio, minimo 2 caratteri')
  }

  const pendingDecisionResult = await handlePendingRenewalsActionDecisionMessage({
    message,
    actorToken: req.auth.token,
  })

  if (pendingDecisionResult) {
    return res.json({
      ...pendingDecisionResult,
      meta: {
        ...(pendingDecisionResult.meta || {}),
        timings: {
          ...(pendingDecisionResult.meta?.timings || {}),
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

  const directPlan = planChatRequest({
    message,
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
    message,
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
