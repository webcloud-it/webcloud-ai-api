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
}
