import {env} from '../../../config/env.js'
import {fetchJson, joinUrl} from '../../../utils/http.js'

export async function getBusinessHours({minisiteIds = [], language = 'it', monthsCount = 2} = {}) {
  if (!env.businessHoursApiBaseUrl) throw new Error('BUSINESS_HOURS_API_BASE_URL non configurato')
  if (!minisiteIds.length) throw new Error('minisiteIds obbligatorio')

  const query = new URLSearchParams({
    minisites: minisiteIds.join(','),
    language,
    monthsCount: String(monthsCount),
  })

  return fetchJson(
    joinUrl(env.businessHoursApiBaseUrl, `/?${query.toString()}`),
    {timeoutMs: 20000},
    'Errore recupero orari dei minisiti'
  )
}

