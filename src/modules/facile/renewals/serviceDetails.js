import {buildServiceSnapshot, getClientSubscriptions} from './snapshots.js'
import {matchesText} from '../../../utils/text.js'

export function extractServiceDetailQuery(message = '') {
  const text = String(message || '').trim()

  const quoted = text.match(/["“”']([^"“”']{2,})["“”']/)
  if (quoted?.[1]) return quoted[1].trim()

  const cleaned = text
    .replace(
      /\b(dammi|mostrami|fammi|dimmi|vedi|vediamo|dettagli|dettaglio|scheda|analizza|analisi|controlla|verifica|informazioni|info|servizio|dominio|cliente|su|di|del|della|per|il|lo|la|i|gli|le)\b/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned.length >= 2 ? cleaned : null
}

export function buildServiceDetailPayload({
  services = [],
  settings = {},
  message = '',
  customerId = null,
  groupId = null,
  serviceId = null,
  serviceIds = [],
  limit = 20,
} = {}) {
  const analysisPeriod = Number(settings.analysis_period ?? 30)
  const thresholds = settings.renewals_low_thresholds || []
  const query = extractServiceDetailQuery(message)

  let filtered = services

  const selectedServiceIds = new Set(
    (Array.isArray(serviceIds) ? serviceIds : []).filter(Boolean).map(String)
  )

  if (selectedServiceIds.size > 0) {
    filtered = filtered.filter(service => {
      return selectedServiceIds.has(String(service?.id))
    })
  } else if (serviceId) {
    filtered = filtered.filter(service => {
      return String(service?.id) === String(serviceId)
    })
  } else {
    if (customerId) {
      filtered = filtered.filter(s => String(s?.customer?.id) === String(customerId))
    }

    if (groupId) {
      filtered = filtered.filter(s => String(s?.customer?.group?.id) === String(groupId))
    }

    if (query) {
      filtered = filtered.filter(s => {
        return (
          matchesText(s?.name, query) ||
          matchesText(s?.customer?.name, query) ||
          matchesText(s?.customer?.businessName, query) ||
          matchesText(s?.customer?.group?.name, query)
        )
      })
    }
  }

  const items = filtered
    .map(service => buildServiceDetailItem(service, {thresholds, analysisPeriod}))
    .sort(compareServiceDetailItems)
    .slice(0, limit)

  return {
    type: 'service-detail',
    query,
    totale: filtered.length,
    items,
  }
}

function buildServiceDetailItem(service, {thresholds, analysisPeriod}) {
  const snapshot = buildServiceSnapshot(service, thresholds, analysisPeriod)

  const subscriptions = getClientSubscriptions(service)
    .filter(sub => sub?.endsOn)
    .map(sub => ({
      id: sub.id,
      name: sub?.plan?.name || sub?.name || sub?.type || null,
      description: sub?.plan?.description || null,
      startsOn: sub.startsOn || null,
      endsOn: sub.endsOn,
      autoRenew: sub?.autoRenew ?? null,
      duration: sub?.plan?.duration || null,
      priceFinal: sub?.plan?.priceFinal ?? null,
      priceList: sub?.plan?.priceList ?? null,
      priceListStandard: sub?.plan?.priceListStandard ?? null,
      missingPrice: sub?.plan?.missingPrice === true,
      supplier: sub?.plan?.supplier?.name || null,
      addons: (sub?.addons || []).map(addon => ({
        name: addon?.name || addon?.plan?.name || null,
      })),
      supplierSubscriptions: (sub?.suppliersSubscriptions || []).map(supplierSub => ({
        id: supplierSub.id,
        endsOn: supplierSub.endsOn || null,
        name: supplierSub?.plan?.name || null,
        description: supplierSub?.plan?.description || null,
        supplier: supplierSub?.plan?.supplier?.name || null,
        missingPrice: supplierSub?.plan?.missingPrice === true,
        priceFinal: supplierSub?.plan?.priceFinal ?? null,
        priceList: supplierSub?.plan?.priceList ?? null,
      })),
    }))
    .sort((a, b) => new Date(a.endsOn) - new Date(b.endsOn))
    .slice(0, 10)

  const communications = (service?.renewalsCommunications || [])
    .filter(item => item?.communicationDate)
    .map(item => ({
      type: item?.type || null,
      typeLabel: item?.typeLabel || null,
      communicationDate: item.communicationDate,
    }))
    .sort((a, b) => {
      return new Date(b.communicationDate).getTime() - new Date(a.communicationDate).getTime()
    })
    .slice(0, 3)

  return {
    id: snapshot.id,
    servizio: snapshot.name,
    cliente: snapshot.customerName,
    gruppo: snapshot.groupName,
    tipologie: buildServiceTypes(service),
    dominio: buildDomainInfo(service),
    priorita: getServicePriority(snapshot),
    motiviPriorita: buildPriorityReasons(snapshot),
    azioniConsigliate: buildSuggestedActions(snapshot),
    rinnovi: {
      imminenti: snapshot.expiringCount,
      urgenti: snapshot.urgentRenewalsCount,
      prossimaScadenza: snapshot.nextRenewalDate,
      subscriptions,
    },
    spazio: {
      percent: snapshot.percent,
      quota: snapshot.quota,
      used: snapshot.used,
      isFull: snapshot.isFull,
      isLow: snapshot.isLow,
      mailboxesSize: Number(service?.pleskDomain?.statsDiskUsage?.mailboxesSize || 0),
      totalMailboxesQuota: Number(service?.pleskDomain?.statsDiskUsage?.totalMailboxesQuota || 0),
      statsDate: service?.pleskDomain?.statsDiskUsage?.date || null,
    },
    traffico: {
      totalTraffic: Number(service?.pleskDomain?.statsTraffic?.totalTraffic || 0),
      aggregationCount: Number(service?.pleskDomain?.statsTraffic?.aggregationCount || 0),
    },
    flags: {
      dontRenew: snapshot.dontRenew,
      autoRenew: snapshot.autoRenew,
      toRenew: snapshot.toRenew,
      toTransfer: snapshot.toTransfer,
      pleskPlansSync: service?.pleskPlansSync === true,
    },
    comunicazioniRecenti: communications,
  }
}

function getServicePriority(snapshot) {
  if (snapshot.dontRenew && snapshot.autoRenew) return 'alta'
  if (snapshot.urgentRenewalsCount > 0) return 'alta'
  if (snapshot.isFull) return 'alta'
  if (snapshot.expiringCount > 0) return 'media'
  if (snapshot.isLow) return 'media'
  if (snapshot.dontRenew) return 'media'

  return 'bassa'
}

function compareServiceDetailItems(a, b) {
  const priorityOrder = {
    alta: 1,
    media: 2,
    bassa: 3,
  }

  const priorityDiff = (priorityOrder[a.priorita] || 99) - (priorityOrder[b.priorita] || 99)

  if (priorityDiff !== 0) return priorityDiff

  const dateA = a.rinnovi?.prossimaScadenza
    ? new Date(a.rinnovi.prossimaScadenza).getTime()
    : Number.MAX_SAFE_INTEGER

  const dateB = b.rinnovi?.prossimaScadenza
    ? new Date(b.rinnovi.prossimaScadenza).getTime()
    : Number.MAX_SAFE_INTEGER

  return dateA - dateB
}

function buildPriorityReasons(snapshot) {
  const reasons = []

  if (snapshot.dontRenew && snapshot.autoRenew) {
    reasons.push('NON RINNOVARE e rinnovo automatico attivi insieme')
  }

  if (snapshot.urgentRenewalsCount > 0) {
    reasons.push(
      `rinnovo urgente${snapshot.nextRenewalDate ? ` entro ${snapshot.nextRenewalDate}` : ''}`
    )
  }

  if (snapshot.isFull) {
    reasons.push(`spazio esaurito (${snapshot.percent.toFixed(1)}%)`)
  } else if (snapshot.isLow) {
    reasons.push(`spazio in esaurimento (${snapshot.percent.toFixed(1)}%)`)
  }

  if (snapshot.expiringCount > 0 && snapshot.urgentRenewalsCount === 0) {
    reasons.push('rinnovo imminente')
  }

  if (snapshot.dontRenew && !snapshot.autoRenew) {
    reasons.push('servizio marcato NON RINNOVARE')
  }

  return reasons
}

function buildSuggestedActions(snapshot) {
  const actions = []

  if (snapshot.dontRenew && snapshot.autoRenew) {
    actions.push('verificare anomalia tra NON RINNOVARE e rinnovo automatico')
  }

  if (snapshot.urgentRenewalsCount > 0) {
    actions.push('verificare o gestire il rinnovo urgente')
  }

  if (snapshot.isFull) {
    actions.push('valutare upgrade spazio o pulizia del servizio')
  } else if (snapshot.isLow) {
    actions.push('monitorare spazio e valutare upgrade')
  }

  if (snapshot.dontRenew) {
    actions.push('verificare che il servizio non venga rinnovato o fatturato per errore')
  }

  return actions
}

function buildServiceTypes(service) {
  return (service?.servicesTypes || []).map(type => ({
    name: type?.name || null,
    macro: type?.macro?.name || null,
  }))
}

function buildDomainInfo(service) {
  const integrations = service?.domains_id?.integrations_data || []

  return {
    domainId: service?.domains_id?.id || null,
    domainName: service?.domains_id?.name || null,
    hasDomainRecord: Boolean(service?.domains_id?.id),
    integrationsCount: integrations.length,
    integrations: integrations.map(item => ({
      type: item?.type || null,
      integrationId: item?.integration_id || null,
    })),
    pleskDomainId: service?.pleskDomain?.id || null,
    pleskIntegrationId: service?.pleskDomain?.integration_id || null,
    hostingType: service?.pleskDomain?.hostingType || null,
    hasPleskDomain: Boolean(service?.pleskDomain?.id),
  }
}
