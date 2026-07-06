export function isLowOnSpace(quotaBytes, percentuale, thresholds = []) {
  if (!quotaBytes || percentuale === 0) return false

  const quotaGB = quotaBytes / 1024 ** 3

  const band = thresholds.find(b => quotaGB >= Number(b.min_gb) && quotaGB <= Number(b.max_gb))

  if (!band) return false

  return percentuale >= Number(band.percent)
}

export function getClientSubscriptions(service) {
  return (service?.subscriptions || []).filter(sub => !sub?.isSupplier)
}

export function getServiceSpaceInfo(service, thresholds = []) {
  const used = Number(service?.pleskDomain?.statsDiskUsage?.totalSize || 0)
  const quota = Number(service?.pleskDomain?.statsDiskUsage?.quota || 0)
  const percent = quota > 0 ? (used / quota) * 100 : 0

  return {
    used,
    quota,
    percent,
    isFull: quota > 0 && percent >= 100,
    isLow: quota > 0 && isLowOnSpace(quota, percent, thresholds),
  }
}

export function getRenewalInfo(service, analysisPeriod) {
  const now = new Date()
  const limit = new Date(now.getTime() + Number(analysisPeriod) * 864e5)

  const subs = getClientSubscriptions(service)
    .filter(sub => sub?.endsOn)
    .map(sub => ({
      ...sub,
      endsOnDate: new Date(sub.endsOn),
    }))

  const expiring = subs.filter(sub => sub.endsOnDate >= now && sub.endsOnDate <= limit)
  const urgent = expiring.filter(sub => (sub.endsOnDate - now) / 864e5 <= 7)

  return {
    subs,
    expiring,
    urgent,
  }
}

export function buildServiceSnapshot(service, thresholds, analysisPeriod) {
  const renewal = getRenewalInfo(service, analysisPeriod)
  const space = getServiceSpaceInfo(service, thresholds)

  return {
    id: service.id,
    name: service.name || '—',
    customerId: service?.customer?.id || null,
    customerName: service?.customer?.name || '—',
    groupId: service?.customer?.group?.id || null,
    groupName: service?.customer?.group?.name || null,
    dontRenew: service?.dontRenew === true,
    autoRenew: service?.autoRenew === true,
    toRenew: service?.toRenew === true || service?.to_renew === true,
    toTransfer: service?.toTransfer ?? service?.to_transfer ?? null,
    expiringCount: renewal.expiring.length,
    urgentRenewalsCount: renewal.urgent.length,
    nextRenewalDate:
      renewal.expiring
        .map(sub => sub.endsOnDate)
        .sort((a, b) => a - b)?.[0]
        ?.toISOString()
        ?.split('T')[0] ?? null,
    isFull: space.isFull,
    isLow: space.isLow,
    percent: space.percent,
    quota: space.quota,
    used: space.used,
  }
}
