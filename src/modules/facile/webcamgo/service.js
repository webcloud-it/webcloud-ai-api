import {env} from '../../../config/env.js'
import {authHeaders, fetchJson, joinUrl} from '../../../utils/http.js'

const DEFAULT_TIMEOUT_MS = Number(env.webcamgoFetchTimeoutMs || 15000)

const WEBCAM_FIELDS = [
  'id',
  'name',
  'slug',
  'webcam_details_id.id',
  'webcam_details_id.installed_on',
  'webcam_details_id.created_on',
  'webcam_details_id.enable_snapshot',
  'webcam_details_id.in_use',
  'webcam_details_id.status_stream_check',
  'webcam_details_id.status_snapshot_check',
  'webcam_details_id.status_connectivity_check',
  'webcam_details_id.status_mikrotik_check',
  'webcam_details_id.encoding_params_id.id',
  'webcam_details_id.locations_id.*',
  'webcam_details_id.network_providers_id.id',
  'webcam_details_id.network_providers_id.name',
  'webcam_details_id.resellers_id.id',
  'webcam_details_id.resellers_id.name',
  'webcam_details_id.webcam_access_id.id',
  'webcam_details_id.webcam_access_id.vpn',
  'webcam_details_id.webcam_access_id.mikrotik_vpn_ip',
  'webcam_details_id.webcam_access_id.connectivity_test_reachable',
  'webcam_details_id.webcam_hardware_id.webcam_models_id.model_number',
  'webcam_details_id.webcam_hardware_id.webcam_models_id.ptz_controls',
  'webcam_details_id.webcam_hardware_id.webcam_models_id.ptz_zoom',
  'webcam_details_id.webcam_hardware_id.webcam_models_id.webcam_brands_id.name',
  'stream_status_logs.status',
  'stream_status_logs.changed_on',
  'snapshot_status_logs.status',
  'snapshot_status_logs.changed_on',
  'connectivity_status_logs.status',
  'connectivity_status_logs.changed_on',
  'mikrotik_status_logs.status',
  'mikrotik_status_logs.changed_on',
]

const DOWNTIME_FIELDS = [
  'id',
  'webcam_id',
  'name',
  'enabled',
  'days_of_week',
  'time_from',
  'time_to',
  'timezone',
  'mode',
  'keep_periodic_snapshot',
  'snapshot_interval_minutes',
  'priority',
  'valid_from',
  'valid_to',
]

function requireWebcamgoConfiguration() {
  if (!env.webcamgoDirectusBaseUrl) {
    throw new Error('WEBCAMGO_DIRECTUS_BASE_URL non configurato')
  }
}

function requireToken(token) {
  if (!token) {
    const error = new Error('Token WebcamGo mancante')
    error.statusCode = 401
    throw error
  }
}

function appendLastStatusAlias(params, alias, type) {
  params.set(`alias[${alias}]`, 'webcam_status_logs')
  params.set(`deep[${alias}][_filter][type][_eq]`, type)
  params.set(`deep[${alias}][_sort]`, '-changed_on')
  params.set(`deep[${alias}][_limit]`, '1')
}

function buildWebcamsUrl({slug = null} = {}) {
  const params = new URLSearchParams()

  params.set('fields', WEBCAM_FIELDS.join(','))
  params.set('limit', '-1')

  appendLastStatusAlias(params, 'stream_status_logs', 'stream')
  appendLastStatusAlias(params, 'snapshot_status_logs', 'snapshot')
  appendLastStatusAlias(params, 'connectivity_status_logs', 'connectivity')
  appendLastStatusAlias(params, 'mikrotik_status_logs', 'mikrotik')

  if (slug) {
    params.set('filter[slug][_eq]', String(slug))
  }

  return joinUrl(env.webcamgoDirectusBaseUrl, `/items/webcams2?${params.toString()}`)
}

function getRelationId(value) {
  return typeof value === 'object' ? value?.id || null : value || null
}

function normalizeStatus(logs = []) {
  const log = Array.isArray(logs) ? logs[0] : null

  return {
    status: log?.status || null,
    changedOn: log?.changed_on || null,
  }
}

function pickLocationLabel(location = null) {
  if (!location || typeof location !== 'object') return null

  const preferredKeys = [
    'name',
    'location',
    'locality',
    'city',
    'municipality',
    'comune',
    'title',
    'address',
  ]

  for (const key of preferredKeys) {
    const value = location[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function normalizeDaysOfWeek(value) {
  if (Array.isArray(value)) {
    return value.map(Number).filter(day => day >= 1 && day <= 7)
  }

  if (typeof value !== 'string') return []

  try {
    const parsed = JSON.parse(value)

    if (Array.isArray(parsed)) {
      return parsed.map(Number).filter(day => day >= 1 && day <= 7)
    }
  } catch (_) {
    return value
      .split(',')
      .map(day => Number(day.trim()))
      .filter(day => day >= 1 && day <= 7)
  }

  return []
}

function normalizeSchedule(schedule = {}) {
  return {
    id: schedule.id || null,
    name: schedule.name || null,
    enabled: schedule.enabled === true,
    daysOfWeek: normalizeDaysOfWeek(schedule.days_of_week),
    timeFrom: schedule.time_from || null,
    timeTo: schedule.time_to || null,
    timezone: schedule.timezone || 'Europe/Rome',
    mode: schedule.mode || null,
    keepPeriodicSnapshot: schedule.keep_periodic_snapshot === true,
    snapshotIntervalMinutes: Number(schedule.snapshot_interval_minutes) || null,
    priority: Number(schedule.priority ?? 100),
    validFrom: schedule.valid_from || null,
    validTo: schedule.valid_to || null,
  }
}

function getLocalDateTimeParts(date, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })

    const parts = Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter(part => part.type !== 'literal')
        .map(part => [part.type, part.value])
    )

    const weekdayMap = {
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
      Sun: 7,
    }

    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      weekday: weekdayMap[parts.weekday] || null,
      minutes: Number(parts.hour) * 60 + Number(parts.minute),
    }
  } catch (_) {
    return null
  }
}

function parseTimeToMinutes(value) {
  if (!value || typeof value !== 'string') return null

  const [hours, minutes] = value.split(':').map(Number)

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null

  return hours * 60 + minutes
}

function isTimeInRange(current, from, to) {
  if (from === null || to === null) return false
  if (from === to) return true
  if (from < to) return current >= from && current < to

  return current >= from || current < to
}

function isScheduleActive(schedule, now = new Date()) {
  if (!schedule?.enabled) return false

  const local = getLocalDateTimeParts(now, schedule.timezone || 'Europe/Rome')

  if (!local?.weekday) return false
  if (schedule.validFrom && local.date < String(schedule.validFrom).slice(0, 10)) return false
  if (schedule.validTo && local.date > String(schedule.validTo).slice(0, 10)) return false
  if (!schedule.daysOfWeek.includes(local.weekday)) return false

  return isTimeInRange(
    local.minutes,
    parseTimeToMinutes(schedule.timeFrom),
    parseTimeToMinutes(schedule.timeTo)
  )
}

function getOverallStatus({stream, snapshot, connectivityTestReachable, snapshotEnabled}) {
  const online =
    stream.status === 'online' &&
    (!snapshotEnabled || snapshot.status === 'online') &&
    connectivityTestReachable !== false

  if (online) return 'online'

  const hasKnownFailure =
    (stream.status && stream.status !== 'online') ||
    (snapshotEnabled && snapshot.status && snapshot.status !== 'online') ||
    connectivityTestReachable === false

  return hasKnownFailure ? 'offline' : 'unknown'
}

function normalizeWebcam(raw = {}, schedules = []) {
  const details = raw.webcam_details_id || {}
  const access = details.webcam_access_id || {}
  const location = details.locations_id || null
  const provider = details.network_providers_id || null
  const reseller = details.resellers_id || null
  const model = details.webcam_hardware_id?.webcam_models_id || null
  const brand = model?.webcam_brands_id || null

  const stream = normalizeStatus(raw.stream_status_logs)
  const snapshot = normalizeStatus(raw.snapshot_status_logs)
  const connectivity = normalizeStatus(raw.connectivity_status_logs)
  const mikrotik = normalizeStatus(raw.mikrotik_status_logs)

  const monitoring = {
    stream: details.status_stream_check === true,
    snapshot: details.status_snapshot_check === true,
    connectivity: details.status_connectivity_check === true,
    mikrotik: details.status_mikrotik_check === true,
  }

  monitoring.any = Object.values(monitoring).some(Boolean)

  const normalizedSchedules = schedules
    .map(normalizeSchedule)
    .sort((a, b) => a.priority - b.priority || String(a.timeFrom).localeCompare(String(b.timeFrom)))

  const activeSchedule = normalizedSchedules.find(schedule => isScheduleActive(schedule)) || null
  const snapshotEnabled = details.enable_snapshot === true
  const connectivityTestReachable =
    typeof access.connectivity_test_reachable === 'boolean'
      ? access.connectivity_test_reachable
      : null

  const status = {
    overall: getOverallStatus({
      stream,
      snapshot,
      connectivityTestReachable,
      snapshotEnabled,
    }),
    stream,
    snapshot,
    connectivity,
    mikrotik,
  }

  return {
    id: raw.id || null,
    name: raw.name || '—',
    slug: raw.slug || null,
    installedOn: details.installed_on || null,
    createdOn: details.created_on || null,
    inUse: details.in_use === true,
    snapshotEnabled,
    hasEncoding: Boolean(details.encoding_params_id),
    location: pickLocationLabel(location),
    reseller: reseller?.name || null,
    networkProvider: provider?.name || null,
    vpn: access.vpn === true,
    hasMikrotik: Boolean(access.vpn || access.mikrotik_vpn_ip),
    connectivityTestReachable,
    hardware: {
      brand: brand?.name || null,
      model: model?.model_number || null,
      ptzControls: model?.ptz_controls === true,
      ptzZoom: model?.ptz_zoom === true,
    },
    monitoring,
    status,
    downtime: {
      configured: normalizedSchedules.length > 0,
      enabledCount: normalizedSchedules.filter(schedule => schedule.enabled).length,
      active: Boolean(activeSchedule),
      activeSchedule,
      schedules: normalizedSchedules,
    },
  }
}

async function fetchDowntimeSchedules({token, webcamIds = []}) {
  if (!webcamIds.length) return new Map()

  const params = new URLSearchParams()
  params.set('fields', DOWNTIME_FIELDS.join(','))
  params.set('filter[webcam_id][_in]', webcamIds.join(','))
  params.set('sort', 'priority,time_from')
  params.set('limit', '-1')

  const json = await fetchJson(
    joinUrl(
      env.webcamgoDirectusBaseUrl,
      `/items/webcam_downtime_schedules?${params.toString()}`
    ),
    {
      headers: authHeaders(token),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    'Errore recupero pianificazioni WebcamGo'
  )

  const schedulesByWebcamId = new Map()

  for (const schedule of json?.data || []) {
    const webcamId = getRelationId(schedule.webcam_id)

    if (!webcamId) continue

    const key = String(webcamId)
    const items = schedulesByWebcamId.get(key) || []
    items.push(schedule)
    schedulesByWebcamId.set(key, items)
  }

  return schedulesByWebcamId
}

export async function getWebcams({token, slug = null} = {}) {
  requireWebcamgoConfiguration()
  requireToken(token)

  const json = await fetchJson(
    buildWebcamsUrl({slug}),
    {
      headers: authHeaders(token),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    'Errore recupero webcam WebcamGo'
  )

  const rawWebcams = Array.isArray(json?.data) ? json.data : []
  const webcamIds = rawWebcams.map(webcam => webcam?.id).filter(Boolean)
  const schedulesByWebcamId = await fetchDowntimeSchedules({token, webcamIds})

  return rawWebcams.map(webcam => {
    return normalizeWebcam(webcam, schedulesByWebcamId.get(String(webcam.id)) || [])
  })
}

async function getWebcamControlTarget({token, webcamId} = {}) {
  requireWebcamgoConfiguration()
  requireToken(token)

  const params = new URLSearchParams()
  params.set('fields', [
    'id',
    'name',
    'slug',
    'webcam_details_id.webcam_access_id.host',
    'webcam_details_id.webcam_access_id.http_port',
    'webcam_details_id.webcam_access_id.user',
    'webcam_details_id.webcam_access_id.password',
    'webcam_details_id.webcam_hardware_id.webcam_models_id.webcam_brands_id.name',
  ].join(','))
  params.set('filter[id][_eq]', String(webcamId))
  params.set('limit', '1')

  const targetJson = await fetchJson(
    joinUrl(env.webcamgoDirectusBaseUrl, `/items/webcams2?${params.toString()}`),
    {headers: authHeaders(token), timeoutMs: DEFAULT_TIMEOUT_MS},
    'Errore recupero accesso webcam'
  )

  const webcam = targetJson?.data?.[0]
  const access = webcam?.webcam_details_id?.webcam_access_id
  if (!webcam || !access?.host || !access?.user || !access?.password) {
    const error = new Error('Webcam non trovata o credenziali tecniche incomplete')
    error.statusCode = 409
    throw error
  }

  return {
    id: webcam.id,
    name: webcam.name,
    slug: webcam.slug,
    ip: access.host,
    port: access.http_port || 80,
    user: access.user,
    pass: access.password,
    brand: webcam?.webcam_details_id?.webcam_hardware_id?.webcam_models_id?.webcam_brands_id?.name || '',
  }
}

async function callControlApi(path, body, errorMessage) {
  if (!env.webcamgoControlApiBaseUrl) {
    const error = new Error('WEBCAMGO_CONTROL_API_BASE_URL non configurato')
    error.statusCode = 503
    throw error
  }

  const headers = {'Content-Type': 'application/json'}
  if (env.webcamgoControlApiKey) headers['x-api-key'] = env.webcamgoControlApiKey

  return fetchJson(
    joinUrl(env.webcamgoControlApiBaseUrl, path),
    {
      method: 'POST',
      headers,
      timeoutMs: 20000,
      body: JSON.stringify(body),
    },
    errorMessage
  )
}

export async function inspectWebcamDevice({token, webcamId} = {}) {
  const target = await getWebcamControlTarget({token, webcamId})
  const result = await callControlApi(
    `/v1/webcams/${encodeURIComponent(target.id)}/onvif/device-info`,
    {ip: target.ip, port: target.port, user: target.user, pass: target.pass},
    'Errore diagnostica ONVIF webcam'
  )

  return {
    ok: result?.ok !== false,
    webcam: {id: target.id, name: target.name, slug: target.slug},
    modelNumber: result?.model_number || null,
    firmwareVersion: result?.firmware_version || null,
    serialNumber: result?.serial_number || null,
    onvifVersion: result?.onvif_version || null,
  }
}

export async function inspectWebcamConnectivity({token, webcamId} = {}) {
  const target = await getWebcamControlTarget({token, webcamId})
  const result = await callControlApi(
    '/v1/connectivity/check',
    {target: target.ip, port: target.port, timeoutMs: 5000},
    'Errore test connettività webcam'
  )

  return {
    ok: result?.ok !== false,
    webcam: {id: target.id, name: target.name, slug: target.slug},
    reachable: result?.reachable === true,
    port: target.port,
  }
}

export async function getWebcamPresets({token, webcamId} = {}) {
  const target = await getWebcamControlTarget({token, webcamId})
  const result = await callControlApi(
    `/v1/webcams/${encodeURIComponent(target.id)}/onvif/presets`,
    {ip: target.ip, port: target.port, user: target.user, pass: target.pass},
    'Errore lettura preset webcam'
  )

  return {
    ok: result?.ok !== false,
    webcam: {id: target.id, name: target.name, slug: target.slug},
    presets: Array.isArray(result?.data)
      ? result.data.map(item => ({token: String(item.token), name: item.name || null}))
      : [],
  }
}

export async function gotoWebcamPreset({token, webcamId, presetToken} = {}) {
  if (presetToken == null || String(presetToken).trim() === '') {
    const error = new Error('Preset webcam mancante')
    error.statusCode = 400
    throw error
  }
  const target = await getWebcamControlTarget({token, webcamId})
  const result = await callControlApi(
    `/v1/webcams/${encodeURIComponent(target.id)}/onvif/presets/goto`,
    {ip: target.ip, port: target.port, user: target.user, pass: target.pass, token: String(presetToken), brand: target.brand},
    'Errore movimento webcam verso preset'
  )

  return {ok: result?.ok !== false, via: result?.via || null}
}

export async function rebootWebcam({token, webcamId} = {}) {
  const target = await getWebcamControlTarget({token, webcamId})
  const result = await callControlApi(
    `/v1/webcams/${encodeURIComponent(target.id)}/reboot`,
    {
      ip: target.ip,
      port: target.port,
      user: target.user,
      pass: target.pass,
      brand: target.brand,
    },
    'Errore riavvio webcam'
  )

  return {ok: result?.ok !== false, via: result?.via || null}
}
