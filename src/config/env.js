import dotenv from 'dotenv'

dotenv.config()

export const env = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  corsOrigin: process.env.CORS_ORIGIN || '*',

  crmDirectusBaseUrl: process.env.CRM_DIRECTUS_BASE_URL,
  crmToken: process.env.CRM_TOKEN,

  renewalsApiBaseUrl: process.env.RENEWALS_API_BASE_URL,

  facileIntegrationsApiBaseUrl: process.env.FACILE_INTEGRATIONS_API_BASE_URL,
  facileAccessToken: process.env.ACCESS_TOKEN,

  webcamgoDirectusBaseUrl: process.env.WEBCAMGO_DIRECTUS_BASE_URL,
  webcamgoFetchTimeoutMs: Number(process.env.WEBCAMGO_FETCH_TIMEOUT_MS || 15000),
  webcamgoControlApiBaseUrl: process.env.WEBCAMGO_CONTROL_API_BASE_URL,
  webcamgoControlApiKey: process.env.WEBCAMGO_CONTROL_API_KEY,

  sendInItalyApiBaseUrl:
    process.env.SENDINITALY_API_BASE_URL ||
    (process.env.NODE_ENV === 'production' ? null : 'http://127.0.0.1:3001/v1'),

  businessHoursApiBaseUrl:
    process.env.BUSINESS_HOURS_API_BASE_URL ||
    (process.env.NODE_ENV === 'production'
      ? 'https://business-hours-api.webcloud.cloud/v1'
      : 'http://127.0.0.1:3002/v1'),
}
