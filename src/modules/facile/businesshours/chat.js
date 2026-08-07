import {getBusinessHours} from './service.js'

function getMinisiteIds(message = '', context = {}) {
  const contextual = [
    context?.params?.id,
    context?.params?.minisiteId,
    context?.minisiteId,
  ].filter(Boolean)

  if (contextual.length) return [...new Set(contextual.map(String))]

  const explicit = String(message).match(/\bminisito\s+(\d+)\b/i)?.[1]
  return explicit ? [explicit] : []
}

function formatResult(items = []) {
  if (!items.length) return 'Non ho trovato orari configurati per il minisito indicato.'

  const lines = []

  for (const item of items) {
    lines.push(`Minisito ${item.minisite}:`)

    if (!item.services?.length) {
      lines.push('- nessun servizio con orari configurati')
      continue
    }

    for (const service of item.services) {
      const state = service.now?.open ? 'aperto' : 'chiuso'
      const changesAt = service.now?.changesAt
        ? `, cambio previsto ${String(service.now.changesAt).replace('T', ' ').slice(0, 16)}`
        : ''
      const inherited = service.inherited ? ' (ereditato)' : ''
      lines.push(`- ${service.name || 'Servizio'}${inherited}: ${state}${changesAt}`)
    }
  }

  return lines.join('\n')
}

export async function handleBusinessHoursChat({message, context = {}} = {}) {
  const minisiteIds = getMinisiteIds(message, context)

  if (!minisiteIds.length) {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: 'Di quale minisito vuoi controllare orari e stato di apertura? Apri il minisito in Facile oppure indicane l’ID.',
      data: {type: 'clarification', reason: 'minisite-required'},
      meta: {moduleId: 'facile.businesshours'},
    }
  }

  const payload = await getBusinessHours({minisiteIds})
  const items = Array.isArray(payload) ? payload : [payload].filter(Boolean)

  return {
    ok: true,
    intent: 'business-hours-status',
    source: 'tool-fast',
    reply: formatResult(items),
    data: {type: 'business-hours-status', minisiteIds, items},
    meta: {moduleId: 'facile.businesshours'},
  }
}

