const MODULE_BY_ENTITY_TYPE = {
  webcam: 'facile.webcamgo',
  service: 'facile.renewals',
  customer: 'facile.renewals',
  group: 'facile.renewals',
}

function cleanValue(value) {
  if (value == null) return null
  const normalized = String(value).trim()
  return normalized || null
}

export function getActiveEntity(context = {}) {
  const raw = context.activeEntity || context.entity || null
  if (!raw || typeof raw !== 'object') return null

  const type = cleanValue(raw.type || raw.kind)
  if (!type) return null

  const entity = {
    type,
    id: cleanValue(raw.id),
    slug: cleanValue(raw.slug),
    name: cleanValue(raw.name || raw.label),
  }

  if (!entity.id && !entity.slug && !entity.name) return null
  return entity
}

export function getEntityModuleId(context = {}) {
  const entity = getActiveEntity(context)
  return entity ? MODULE_BY_ENTITY_TYPE[entity.type] || null : null
}

export function getContextScope(context = {}) {
  const entity = getActiveEntity(context)
  const scope = context.scope && typeof context.scope === 'object' ? context.scope : {}
  const params = context.params && typeof context.params === 'object' ? context.params : {}
  const query = context.query && typeof context.query === 'object' ? context.query : {}

  const customerId = cleanValue(
    context.customerId || scope.customerId || query.customerId || query.customer_id
  )
  const groupId = cleanValue(context.groupId || scope.groupId || query.groupId || query.group_id)
  const serviceId = cleanValue(
    context.serviceId || scope.serviceId || query.serviceId || query.service_id
  )
  const webcamSlug = cleanValue(
    context.webcamSlug ||
      scope.webcamSlug ||
      (entity?.type === 'webcam' ? entity.slug : null) ||
      params.slug
  )

  return {
    customerId: customerId || (entity?.type === 'customer' ? entity.id : null),
    groupId: groupId || (entity?.type === 'group' ? entity.id : null),
    serviceId: serviceId || (entity?.type === 'service' ? entity.id : null),
    webcamSlug,
  }
}

export function getContextEntityTarget(context = {}, type = null) {
  const entity = getActiveEntity(context)
  if (entity && (!type || entity.type === type)) {
    return entity.slug || entity.id || entity.name || null
  }

  if (type === 'webcam') return getContextScope(context).webcamSlug
  return null
}

export function contextualizeRenewalsMessage(message = '', scope = {}) {
  const original = String(message || '').trim()
  if (!original) return original

  const serviceId = cleanValue(scope.serviceId)
  const customerId = cleanValue(scope.customerId)
  const groupId = cleanValue(scope.groupId)

  if (serviceId) {
    if (
      /^(?:(?:mostra(?:mi)?|dammi)\s+)?(?:i\s+)?(?:dettagli|informazioni|info|scheda)(?:\s+(?:di|su))?(?:\s+(?:quest[oa]|il|del)\s+servizio)?[?.!]*$/i.test(original) ||
      /^(?:come\s+sta|che\s+stato\s+ha|qual\s+[eè]\s+lo\s+stato)(?:\s+(?:quest[oa]|il)\s+servizio)?[?.!]*$/i.test(original)
    ) {
      return `dettagli del servizio ${serviceId}`
    }

    if (/^(?:e\s+)?(?:qual\s+[eè]\s+)?(?:la\s+)?scadenza(?:\s+cliente)?[?.!]*$/i.test(original)) {
      return `qual è la scadenza cliente del servizio ${serviceId}`
    }

    if (/^(?:e\s+)?(?:quanto|qual\s+[eè])?\s*(?:lo\s+)?spazio(?:\s+usato|\s+disponibile)?[?.!]*$/i.test(original)) {
      return `dettagli del servizio ${serviceId}`
    }
  }

  if ((customerId || groupId) && /^(?:mostra(?:mi)?\s+)?(?:il\s+)?(?:riepilogo|situazione|stato|dettagli|informazioni)(?:\s+(?:di|su))?(?:\s+quest[oa])?[?.!]*$/i.test(original)) {
    return 'mostrami il riepilogo'
  }

  return original
}
