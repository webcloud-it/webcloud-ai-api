import {getChatAuditSummary} from '../../../core/observability/chatAudit.js'
import {getAllServices, getSettings} from '../renewals/service.js'
import {buildServiceSnapshot} from '../renewals/snapshots.js'
import {getCampaigns} from '../sendinitaly/service.js'
import {getWebcams} from '../webcamgo/service.js'
import {buildWebcamSummaryPayload} from '../webcamgo/queries.js'

function campaignTotal(payload = {}) {
  return Number(payload?.meta?.total ?? payload?.meta?.total_rows ?? payload?.data?.length ?? 0)
}

function safeFailure(id, label, reason) {
  console.warn('[operational-overview]', JSON.stringify({source: id, status: Number(reason?.statusCode || reason?.status) || null, errorName: reason?.name || 'Error'}))
  return {id, label, ok: false, metrics: [], alerts: [], errorCode: 'source-unavailable'}
}

async function renewalsSource() {
  const [services, settings] = await Promise.all([getAllServices(), getSettings()])
  const snapshots = services.map(service => buildServiceSnapshot(service, settings.renewals_low_thresholds || [], Number(settings.analysis_period ?? 30)))
  const metrics = {
    total: snapshots.length,
    expiring: snapshots.filter(item => item.expiringCount > 0).length,
    urgent: snapshots.filter(item => item.urgentRenewalsCount > 0).length,
    full: snapshots.filter(item => item.isFull).length,
    low: snapshots.filter(item => item.isLow && !item.isFull).length,
  }
  const alerts = [
    metrics.urgent ? {level: 'high', label: `${metrics.urgent} rinnovi urgenti`} : null,
    metrics.full ? {level: 'high', label: `${metrics.full} servizi con spazio esaurito`} : null,
    metrics.low ? {level: 'medium', label: `${metrics.low} servizi con spazio in esaurimento`} : null,
  ].filter(Boolean)
  return {id: 'renewals', label: 'Rinnovi', ok: true, metrics, alerts, action: {id: 'navigate', label: 'Apri rinnovi', path: '/crm/renewals'}}
}

async function webcamSource(token) {
  const webcams = await getWebcams({token})
  const summary = buildWebcamSummaryPayload(webcams).summary || {}
  const unexpectedOffline = Math.max(0, Number(summary.offline || 0) - Number(summary.scheduledDowntime || 0))
  const metrics = {
    total: Number(summary.total || 0),
    online: Number(summary.online || 0),
    unexpectedOffline,
    streamOffline: Number(summary.streamOffline || 0),
    connectivityProblems: Number(summary.connectivityProblems || 0),
    mikrotikOffline: Number(summary.mikrotikOffline || 0),
  }
  const alerts = [
    metrics.unexpectedOffline ? {level: 'high', label: `${metrics.unexpectedOffline} webcam offline fuori downtime`} : null,
    metrics.connectivityProblems ? {level: 'high', label: `${metrics.connectivityProblems} problemi di connettività`} : null,
    metrics.streamOffline ? {level: 'medium', label: `${metrics.streamOffline} stream non online`} : null,
    metrics.mikrotikOffline ? {level: 'medium', label: `${metrics.mikrotikOffline} MikroTik non online`} : null,
  ].filter(Boolean)
  return {id: 'webcamgo', label: 'WebcamGo', ok: true, metrics, alerts, action: {id: 'navigate', label: 'Apri WebcamGo', path: '/webcamgo'}}
}

async function sendInItalySource(token) {
  const [queued, inProcess] = await Promise.all([
    getCampaigns({token, status: 'queued', limit: 1}),
    getCampaigns({token, status: 'in_process', limit: 1}),
  ])
  const metrics = {queued: campaignTotal(queued), inProcess: campaignTotal(inProcess)}
  const alerts = metrics.queued > 20 ? [{level: 'medium', label: `${metrics.queued} campagne in coda`}]: []
  return {id: 'sendinitaly', label: 'Send in Italy', ok: true, metrics, alerts, action: {id: 'navigate', label: 'Apri campagne', path: '/sendinitaly/campaigns'}}
}

function chatbotSource() {
  const summary = getChatAuditSummary({windowMinutes: 60})
  const metrics = {requests: summary.requests, successRate: summary.successRate, averageDurationMs: summary.averageDurationMs, failures: summary.failures, slowRequests: summary.slowRequests}
  const alerts = [
    summary.failures ? {level: summary.successRate < 95 ? 'high' : 'medium', label: `${summary.failures} richieste chatbot fallite`} : null,
    summary.slowRequests ? {level: 'medium', label: `${summary.slowRequests} richieste chatbot lente`} : null,
  ].filter(Boolean)
  return {id: 'chatbot', label: 'Chatbot', ok: true, metrics, alerts}
}

export async function getOperationalOverview({credentials = {}, services = {renewalsSource, webcamSource, sendInItalySource, chatbotSource}} = {}) {
  const jobs = [
    {id: 'renewals', label: 'Rinnovi', available: Boolean(credentials.crm), run: () => services.renewalsSource()},
    {id: 'webcamgo', label: 'WebcamGo', available: Boolean(credentials.webcamgo), run: () => services.webcamSource(credentials.webcamgo)},
    {id: 'sendinitaly', label: 'Send in Italy', available: Boolean(credentials.specialk), run: () => services.sendInItalySource(credentials.specialk)},
    {id: 'chatbot', label: 'Chatbot', available: Boolean(credentials.crm), run: () => services.chatbotSource()},
  ]
  const sources = await Promise.all(jobs.map(async job => {
    if (!job.available) return {...safeFailure(job.id, job.label, 'credenziale non disponibile'), unavailable: true}
    try {
      return await job.run()
    } catch (error) {
      return safeFailure(job.id, job.label, error)
    }
  }))
  const alerts = sources.flatMap(source => source.alerts || []).sort((a, b) => (a.level === 'high' ? -1 : 1) - (b.level === 'high' ? -1 : 1))
  return {sources, alerts, availableSources: sources.filter(item => item.ok).length, unavailableSources: sources.filter(item => !item.ok).length}
}
