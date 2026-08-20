import dotenv from 'dotenv'

dotenv.config()

const nodeEnv = process.env.NODE_ENV || 'development'
const isProduction = nodeEnv === 'production'
const corsOrigins = String(
  process.env.CORS_ORIGIN || (isProduction ? 'https://facile.webcloud.it' : '*')
)
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)

export const env = {
  port: Number(process.env.PORT || 3000),
  nodeEnv,
  isProduction,
  corsOrigin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,

  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  ollamaApiKey: process.env.OLLAMA_API_KEY || null,
  ollamaChatModel: process.env.OLLAMA_CHAT_MODEL || 'qwen3.5:0.8b',
  ollamaTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || 45000),
  ollamaRouterTimeoutMs: Number(process.env.OLLAMA_ROUTER_TIMEOUT_MS || 15000),
  ollamaReadPlannerTimeoutMs: Number(process.env.OLLAMA_READ_PLANNER_TIMEOUT_MS || 12000),
  ollamaRequired: String(process.env.OLLAMA_REQUIRED || '').toLowerCase() === 'true',
  ollamaThink: String(process.env.OLLAMA_THINK || 'false').toLowerCase() === 'true',
  ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE || '10m',
  groundedRepliesEnabled:
    String(process.env.AI_GROUNDED_REPLIES_ENABLED || 'true').toLowerCase() !== 'false',
  groundedReplyTimeoutMs: Number(process.env.AI_GROUNDED_REPLY_TIMEOUT_MS || 12000),

  authValidationTimeoutMs: Number(process.env.AUTH_VALIDATION_TIMEOUT_MS || 5000),
  authCacheTtlMs: Number(process.env.AUTH_CACHE_TTL_MS || 60000),
  allowedCrmRoleIds: String(process.env.AI_ALLOWED_CRM_ROLE_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
  feedbackStoragePath: process.env.AI_FEEDBACK_STORAGE_PATH || './data/chat-feedback.jsonl',
  feedbackMaxEntries: Math.max(100, Number(process.env.AI_FEEDBACK_MAX_ENTRIES || 10000)),

  crmDirectusBaseUrl: process.env.CRM_DIRECTUS_BASE_URL,
  crmToken: process.env.CRM_TOKEN,

  renewalsApiBaseUrl: process.env.RENEWALS_API_BASE_URL,

  facileIntegrationsApiBaseUrl: process.env.FACILE_INTEGRATIONS_API_BASE_URL,
  facileAccessToken: process.env.ACCESS_TOKEN,

  webcamgoDirectusBaseUrl: process.env.WEBCAMGO_DIRECTUS_BASE_URL,
  webcamgoFetchTimeoutMs: Number(process.env.WEBCAMGO_FETCH_TIMEOUT_MS || 15000),
  webcamgoCacheTtlMs: Math.max(0, Number(process.env.WEBCAMGO_CACHE_TTL_MS || 20000)),
  webcamgoControlApiBaseUrl: process.env.WEBCAMGO_CONTROL_API_BASE_URL,
  webcamgoControlApiKey: process.env.WEBCAMGO_CONTROL_API_KEY,

  sendInItalyApiBaseUrl:
    process.env.SENDINITALY_API_BASE_URL ||
    (process.env.NODE_ENV === 'production' ? null : 'http://127.0.0.1:3001/v1'),

  asiagoCmsBaseUrl: process.env.ASIAGO_CMS_BASE_URL || 'https://cms.asiago.it',
  asiagoSnowBulletinBaseUrl:
    process.env.ASIAGO_SNOWBULLETIN_BASE_URL || 'https://snowbulletin-cms.webcloud.cloud',
  asiagoPricelistsBaseUrl:
    process.env.ASIAGO_PRICELISTS_BASE_URL || 'https://spine01-cms.webcloud.cloud',
  asiagoNozomiBaseUrl: process.env.ASIAGO_NOZOMI_BASE_URL || 'https://nozomi.asiago.it',
  wamCmsBaseUrl: process.env.WAM_CMS_BASE_URL || 'https://wam-cms.webcloud.cloud',
  cloudflareCacheApiBaseUrl:
    process.env.CLOUDFLARE_CACHE_API_BASE_URL || 'https://matteo-magic-cache--buster.webcloudit.workers.dev',

  businessHoursApiBaseUrl:
    process.env.BUSINESS_HOURS_API_BASE_URL ||
    (process.env.NODE_ENV === 'production'
      ? 'https://business-hours-api.webcloud.cloud/v1'
      : 'http://127.0.0.1:3002/v1'),
}
