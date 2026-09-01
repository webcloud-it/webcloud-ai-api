function sanitizeBuildValue(value = '', fallback = null) {
  const normalized = String(value || '').trim()
  if (!normalized || !/^[a-zA-Z0-9._-]{1,80}$/.test(normalized)) return fallback
  return normalized
}

const commit = sanitizeBuildValue(
  process.env.GIT_COMMIT_SHA ||
  process.env.COMMIT_SHA ||
  process.env.SOURCE_COMMIT ||
  process.env.EASYPANEL_GIT_COMMIT_SHA,
  null
)

export const buildInfo = Object.freeze({
  id: sanitizeBuildValue(process.env.API_BUILD_ID, '2026.09.01-grounded-analytics-v9'),
  commit,
})
