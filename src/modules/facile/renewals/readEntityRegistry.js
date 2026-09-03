function normalizeText(value = '') {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function stableKey(...parts) {
  return parts.map(part => normalizeText(part || '')).join('|')
}

function uniq(values = []) {
  return [...new Set(values.filter(value => value !== null && value !== undefined && value !== ''))]
}

function toDateYear(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.getFullYear()
}

function flattenSupplierSubscriptions(service = {}) {
  const direct = (service.subscriptions || []).filter(sub => sub?.isSupplier === true)
  const nested = (service.subscriptions || [])
    .flatMap(sub => sub?.suppliersSubscriptions || sub?.supplierSubscriptions || [])
    .filter(Boolean)

  const byId = new Map()
  for (const sub of [...direct, ...nested]) {
    const key = String(sub?.id || stableKey(sub?.plan?.name, sub?.endsOn, sub?.startsOn))
    if (!byId.has(key)) byId.set(key, sub)
  }

  return [...byId.values()]
}

function flattenAllSubscriptions(service = {}) {
  const customer = (service.subscriptions || []).filter(sub => sub?.isSupplier !== true)
  const supplier = flattenSupplierSubscriptions(service)
  return [...customer, ...supplier]
}

function flattenPlanRefs(service = {}) {
  const out = []

  for (const sub of flattenAllSubscriptions(service)) {
    if (sub?.plan) {
      out.push({
        plan: sub.plan,
        kind: sub.isSupplier === true ? 'supplier' : 'customer',
        subscription: sub,
      })
    }

    for (const addon of sub?.addons || []) {
      out.push({
        plan: {
          id: addon?.addonId || addon?.id || null,
          name: addon?.name || addon?.plan?.name || null,
          description: addon?.description || addon?.plan?.description || null,
          duration: addon?.duration || addon?.plan?.duration || null,
          supplier: addon?.supplier || addon?.plan?.supplier || sub?.plan?.supplier || null,
          resources: addon?.resources || addon?.plan?.resources || [],
          servicesTypesIn: addon?.servicesTypesIn || addon?.plan?.servicesTypesIn || [],
          servicesTypesOut: addon?.servicesTypesOut || addon?.plan?.servicesTypesOut || [],
          priceFinal: addon?.priceFinal ?? addon?.plan?.priceFinal ?? null,
          priceList: addon?.priceList ?? addon?.plan?.priceList ?? null,
          priceListStandard: addon?.priceListStandard ?? addon?.plan?.priceListStandard ?? null,
          missingPrice: addon?.missingPrice === true || addon?.plan?.missingPrice === true,
        },
        kind: 'addon',
        subscription: sub,
      })
    }
  }

  return out.filter(ref => ref.plan?.id || ref.plan?.name)
}

function relationId(value) {
  if (!value) return null
  if (typeof value === 'object') return value.id || null
  return value
}

function relationName(value) {
  if (!value) return null
  if (typeof value === 'object') return value.name || value.label || null
  return String(value)
}

function createBaseDefinition({
  id,
  label,
  singular,
  aliases,
  fields,
  defaultSort,
  buildRecords,
  catalog = null,
  analytics = null,
}) {
  return {
    id,
    label,
    singular,
    aliases,
    fields,
    defaultSort,
    buildRecords,
    catalog,
    analytics,
  }
}

function buildProviders({services = [], options = {}} = {}) {
  const map = new Map()
  const now = Date.now()

  const ensure = provider => {
    const id = relationId(provider)
    const name = relationName(provider)
    if (!id && !name) return null
    const key = id ? String(id) : stableKey(name)

    if (!map.has(key)) {
      map.set(key, {
        id: id || key,
        name: name || String(id),
        serviceIds: new Set(),
        subscriptionIds: new Set(),
        planIds: new Set(),
        planNames: new Set(),
        expiryYears: new Set(),
        nextExpiry: null,
      })
    }

    return map.get(key)
  }

  for (const option of options.providers || []) {
    ensure({id: option.value, name: option.label})
  }

  for (const service of services) {
    for (const ref of flattenPlanRefs(service)) {
      const provider = ensure(ref.plan?.supplier)
      if (!provider) continue

      if (service?.id) provider.serviceIds.add(String(service.id))
      if (ref.subscription?.id) provider.subscriptionIds.add(String(ref.subscription.id))
      if (ref.plan?.id) provider.planIds.add(String(ref.plan.id))
      if (ref.plan?.name) provider.planNames.add(ref.plan.name)

      const year = toDateYear(ref.subscription?.endsOn)
      if (year) provider.expiryYears.add(year)

      const expiry = ref.subscription?.endsOn ? new Date(ref.subscription.endsOn) : null
      if (expiry && !Number.isNaN(expiry.getTime()) && expiry.getTime() >= now) {
        if (!provider.nextExpiry || expiry < new Date(provider.nextExpiry)) {
          provider.nextExpiry = expiry.toISOString()
        }
      }
    }
  }

  return [...map.values()].map(item => ({
    id: item.id,
    name: item.name,
    serviceCount: item.serviceIds.size,
    subscriptionCount: item.subscriptionIds.size,
    planCount: item.planIds.size || item.planNames.size,
    planNames: [...item.planNames].sort((a, b) => a.localeCompare(b, 'it')),
    expiryYears: [...item.expiryYears].sort(),
    nextExpiry: item.nextExpiry,
    present: item.subscriptionIds.size > 0,
  }))
}

function buildCustomers({services = [], options = {}} = {}) {
  const map = new Map()

  const ensure = customer => {
    const id = relationId(customer)
    const name = relationName(customer)
    if (!id && !name) return null
    const key = id ? String(id) : stableKey(name)

    if (!map.has(key)) {
      map.set(key, {
        id: id || key,
        name: name || String(id),
        group: null,
        serviceIds: new Set(),
        planIds: new Set(),
        providerNames: new Set(),
        expiryYears: new Set(),
        expiryDates: new Set(),
      })
    }

    return map.get(key)
  }

  for (const option of options.customers || []) {
    ensure({id: option.value, name: option.label})
  }

  for (const service of services) {
    const target = ensure(service?.customer)
    if (!target) continue

    target.group = service?.customer?.group
      ? {
          id: service.customer.group.id || null,
          name: service.customer.group.name || null,
        }
      : null

    if (service?.id) target.serviceIds.add(String(service.id))

    for (const ref of flattenPlanRefs(service)) {
      if (ref.plan?.id) target.planIds.add(String(ref.plan.id))
      const providerName = relationName(ref.plan?.supplier)
      if (providerName) target.providerNames.add(providerName)
      if (ref.kind !== 'supplier') {
        const year = toDateYear(ref.subscription?.endsOn)
        if (year) target.expiryYears.add(year)

        const expiry = ref.subscription?.endsOn ? new Date(ref.subscription.endsOn) : null
        if (expiry && !Number.isNaN(expiry.getTime())) {
          target.expiryDates.add(expiry.toISOString())
        }
      }
    }
  }

  return [...map.values()].map(item => ({
    id: item.id,
    name: item.name,
    group: item.group,
    serviceCount: item.serviceIds.size,
    planCount: item.planIds.size,
    providerNames: [...item.providerNames].sort((a, b) => a.localeCompare(b, 'it')),
    expiryYears: [...item.expiryYears].sort(),
    expiryDates: [...item.expiryDates].sort(),
  }))
}

function buildGroups({services = [], options = {}} = {}) {
  const map = new Map()

  const ensure = group => {
    const id = relationId(group)
    const name = relationName(group)
    if (!id && !name) return null
    const key = id ? String(id) : stableKey(name)

    if (!map.has(key)) {
      map.set(key, {
        id: id || key,
        name: name || String(id),
        customerIds: new Set(),
        serviceIds: new Set(),
        providerNames: new Set(),
        expiryYears: new Set(),
      })
    }

    return map.get(key)
  }

  for (const option of options.groups || []) {
    ensure({id: option.value, name: option.label})
  }

  for (const service of services) {
    const target = ensure(service?.customer?.group)
    if (!target) continue

    if (service?.customer?.id) target.customerIds.add(String(service.customer.id))
    if (service?.id) target.serviceIds.add(String(service.id))

    for (const ref of flattenPlanRefs(service)) {
      const providerName = relationName(ref.plan?.supplier)
      if (providerName) target.providerNames.add(providerName)
      const year = toDateYear(ref.subscription?.endsOn)
      if (year) target.expiryYears.add(year)
    }
  }

  return [...map.values()].map(item => ({
    id: item.id,
    name: item.name,
    customerCount: item.customerIds.size,
    serviceCount: item.serviceIds.size,
    providerNames: [...item.providerNames].sort((a, b) => a.localeCompare(b, 'it')),
    expiryYears: [...item.expiryYears].sort(),
  }))
}

function buildPlans({services = []} = {}, {addonsOnly = false} = {}) {
  const map = new Map()

  for (const service of services) {
    for (const ref of flattenPlanRefs(service)) {
      if (addonsOnly && ref.kind !== 'addon') continue
      if (!addonsOnly && ref.kind === 'addon') continue

      const plan = ref.plan
      const key = plan?.id ? String(plan.id) : stableKey(plan?.name, relationName(plan?.supplier))
      if (!key) continue

      if (!map.has(key)) {
        map.set(key, {
          id: plan?.id || key,
          name: plan?.name || String(plan?.id || key),
          description: plan?.description || null,
          duration: plan?.duration ?? null,
          supplier: plan?.supplier
            ? {id: relationId(plan.supplier), name: relationName(plan.supplier)}
            : null,
          sourceKinds: new Set(),
          serviceIds: new Set(),
          subscriptionIds: new Set(),
          customerNames: new Set(),
          groupNames: new Set(),
          resources: new Map(),
          servicesTypesIn: new Map(),
          servicesTypesOut: new Map(),
          expiryYears: new Set(),
          prices: new Set(),
          missingPrice: false,
        })
      }

      const target = map.get(key)
      target.sourceKinds.add(ref.kind)
      if (service?.id) target.serviceIds.add(String(service.id))
      if (ref.subscription?.id) target.subscriptionIds.add(String(ref.subscription.id))
      if (service?.customer?.name) target.customerNames.add(service.customer.name)
      if (service?.customer?.group?.name) target.groupNames.add(service.customer.group.name)
      const year = toDateYear(ref.subscription?.endsOn)
      if (year) target.expiryYears.add(year)

      for (const resource of plan?.resources || []) {
        const resourceName = resource?.name || resource?.resources_id?.name
        if (!resourceName) continue
        const resourceKey = resource?.id || resource?.resources_id?.id || stableKey(resourceName)
        if (!target.resources.has(resourceKey)) {
          target.resources.set(resourceKey, {
            id: resource?.id || resource?.resources_id?.id || resourceKey,
            name: resourceName,
            amounts: new Set(),
          })
        }
        if (resource?.amount !== null && resource?.amount !== undefined) {
          target.resources.get(resourceKey).amounts.add(resource.amount)
        }
      }

      for (const type of plan?.servicesTypesIn || []) {
        const typeName = type?.name || type?.services_types_id?.name
        if (!typeName) continue
        const typeKey = type?.id || type?.services_types_id?.id || stableKey(typeName)
        target.servicesTypesIn.set(typeKey, {
          id: type?.id || type?.services_types_id?.id || typeKey,
          name: typeName,
        })
      }

      for (const type of plan?.servicesTypesOut || []) {
        const typeName = type?.name || type?.services_types_id?.name
        if (!typeName) continue
        const typeKey = type?.id || type?.services_types_id?.id || stableKey(typeName)
        target.servicesTypesOut.set(typeKey, {
          id: type?.id || type?.services_types_id?.id || typeKey,
          name: typeName,
        })
      }

      for (const price of [plan?.priceFinal, plan?.priceList, plan?.priceListStandard]) {
        if (price !== null && price !== undefined && Number.isFinite(Number(price))) {
          target.prices.add(Number(price))
        }
      }
      target.missingPrice = target.missingPrice || plan?.missingPrice === true
    }
  }

  return [...map.values()].map(item => ({
    id: item.id,
    name: item.name,
    description: item.description,
    type: item.sourceKinds.has('addon') ? '2' : '1',
    kind: item.sourceKinds.has('addon') ? 'addon' : 'base',
    duration: item.duration,
    supplier: item.supplier,
    sourceKinds: [...item.sourceKinds].sort(),
    isAddon: item.sourceKinds.has('addon'),
    serviceCount: item.serviceIds.size,
    subscriptionCount: item.subscriptionIds.size,
    customerNames: [...item.customerNames].sort((a, b) => a.localeCompare(b, 'it')),
    groupNames: [...item.groupNames].sort((a, b) => a.localeCompare(b, 'it')),
    resourceNames: [...item.resources.values()].map(resource => resource.name),
    resources: [...item.resources.values()].map(resource => ({
      id: resource.id,
      name: resource.name,
      amounts: [...resource.amounts],
    })),
    serviceTypeInNames: [...item.servicesTypesIn.values()].map(type => type.name),
    serviceTypeOutNames: [...item.servicesTypesOut.values()].map(type => type.name),
    servicesTypesIn: [...item.servicesTypesIn.values()],
    servicesTypesOut: [...item.servicesTypesOut.values()],
    expiryYears: [...item.expiryYears].sort(),
    prices: [...item.prices].sort((a, b) => a - b),
    missingPrice: item.missingPrice,
  }))
}

function buildResources(context = {}) {
  const plans = buildPlans(context)
  const map = new Map()

  for (const plan of plans) {
    for (const resource of plan.resources || []) {
      const key = resource.id || stableKey(resource.name)
      if (!map.has(key)) {
        map.set(key, {
          id: resource.id || key,
          name: resource.name,
          planIds: new Set(),
          planNames: new Set(),
          supplierNames: new Set(),
          amounts: new Set(),
          planUsages: new Map(),
        })
      }

      const target = map.get(key)
      if (plan.id) target.planIds.add(String(plan.id))
      if (plan.name) target.planNames.add(plan.name)
      if (plan.supplier?.name) target.supplierNames.add(plan.supplier.name)
      for (const amount of resource.amounts || []) target.amounts.add(amount)

      const usageKey = String(plan.id || stableKey(plan.name, plan.supplier?.name))
      if (!target.planUsages.has(usageKey)) {
        target.planUsages.set(usageKey, {
          planId: plan.id || null,
          planName: plan.name || null,
          supplierName: plan.supplier?.name || null,
          amounts: new Set(),
        })
      }
      for (const amount of resource.amounts || []) {
        target.planUsages.get(usageKey).amounts.add(amount)
      }
    }
  }

  return [...map.values()].map(item => ({
    id: item.id,
    name: item.name,
    planCount: item.planIds.size || item.planNames.size,
    planNames: [...item.planNames].sort((a, b) => a.localeCompare(b, 'it')),
    supplierNames: [...item.supplierNames].sort((a, b) => a.localeCompare(b, 'it')),
    amounts: [...item.amounts].sort((a, b) => Number(a) - Number(b)),
    planUsages: [...item.planUsages.values()].map(usage => ({
      planId: usage.planId,
      planName: usage.planName,
      supplierName: usage.supplierName,
      amounts: [...usage.amounts].sort((a, b) => Number(a) - Number(b)),
    })),
  }))
}

function buildServiceTypes({services = [], options = {}} = {}) {
  const map = new Map()

  const ensure = type => {
    const id = relationId(type)
    const name = relationName(type)
    if (!id && !name) return null
    const key = id ? String(id) : stableKey(name)

    if (!map.has(key)) {
      map.set(key, {
        id: id || key,
        name: name || String(id),
        macro: type?.macro
          ? {id: relationId(type.macro), name: relationName(type.macro)}
          : type?.macro_services_types_id
            ? {
                id: relationId(type.macro_services_types_id),
                name: relationName(type.macro_services_types_id),
              }
            : null,
        serviceIds: new Set(),
        planInIds: new Set(),
        planOutIds: new Set(),
      })
    }

    return map.get(key)
  }

  for (const option of options.serviceTypes || []) {
    ensure({id: option.value, name: option.label})
  }

  for (const service of services) {
    for (const type of service?.servicesTypes || []) {
      const target = ensure(type)
      if (target && service?.id) target.serviceIds.add(String(service.id))
    }

    for (const ref of flattenPlanRefs(service)) {
      for (const type of ref.plan?.servicesTypesIn || []) {
        const target = ensure(type)
        if (target && ref.plan?.id) target.planInIds.add(String(ref.plan.id))
      }
      for (const type of ref.plan?.servicesTypesOut || []) {
        const target = ensure(type)
        if (target && ref.plan?.id) target.planOutIds.add(String(ref.plan.id))
      }
    }
  }

  return [...map.values()].map(item => ({
    id: item.id,
    name: item.name,
    macro: item.macro,
    serviceCount: item.serviceIds.size,
    planInCount: item.planInIds.size,
    planOutCount: item.planOutIds.size,
  }))
}

function buildMacroServiceTypes(context = {}) {
  const types = buildServiceTypes(context)
  const map = new Map()

  for (const type of types) {
    if (!type.macro?.id && !type.macro?.name) continue
    const key = type.macro.id ? String(type.macro.id) : stableKey(type.macro.name)

    if (!map.has(key)) {
      map.set(key, {
        id: type.macro.id || key,
        name: type.macro.name || String(type.macro.id),
        serviceTypeIds: new Set(),
        serviceCount: 0,
        planInCount: 0,
        planOutCount: 0,
      })
    }

    const target = map.get(key)
    target.serviceTypeIds.add(String(type.id))
    target.serviceCount += Number(type.serviceCount || 0)
    target.planInCount += Number(type.planInCount || 0)
    target.planOutCount += Number(type.planOutCount || 0)
  }

  return [...map.values()].map(item => ({
    id: item.id,
    name: item.name,
    serviceTypeCount: item.serviceTypeIds.size,
    serviceCount: item.serviceCount,
    planInCount: item.planInCount,
    planOutCount: item.planOutCount,
  }))
}

function buildSubscriptions({services = []} = {}) {
  const out = []

  for (const service of services) {
    const usedSpace = Number(service?.pleskDomain?.statsDiskUsage?.totalSize || 0)
    const spaceQuota = Number(service?.pleskDomain?.statsDiskUsage?.quota || 0)
    const spacePercent = spaceQuota > 0 ? (usedSpace / spaceQuota) * 100 : null

    for (const sub of flattenAllSubscriptions(service)) {
      out.push({
        id: sub?.id || stableKey(service?.id, sub?.plan?.name, sub?.startsOn, sub?.endsOn),
        name: `${service?.name || 'Servizio'} · ${sub?.plan?.name || 'sottoscrizione'}`,
        kind: sub?.isSupplier === true ? 'supplier' : 'customer',
        service: {id: service?.id || null, name: service?.name || null},
        domain: service?.domains_id
          ? {id: service.domains_id.id || null, name: service.domains_id.name || null}
          : null,
        serviceHasPlesk: Boolean(service?.pleskDomain?.id),
        serviceSpacePercent: spacePercent,
        serviceSpaceFull: spacePercent !== null && spacePercent >= 100,
        serviceDontRenew: service?.dontRenew === true,
        serviceToTransfer: Boolean(service?.toTransfer),
        customer: service?.customer
          ? {id: service.customer.id || null, name: service.customer.name || null}
          : null,
        group: service?.customer?.group
          ? {id: service.customer.group.id || null, name: service.customer.group.name || null}
          : null,
        plan: sub?.plan ? {id: sub.plan.id || null, name: sub.plan.name || null} : null,
        supplier: sub?.plan?.supplier
          ? {id: relationId(sub.plan.supplier), name: relationName(sub.plan.supplier)}
          : null,
        startsOn: sub?.startsOn || null,
        endsOn: sub?.endsOn || null,
        expiryYear: toDateYear(sub?.endsOn),
        addonCount: Array.isArray(sub?.addons) ? sub.addons.length : 0,
      })
    }
  }

  return out
}

function buildDomains({services = []} = {}) {
  const map = new Map()

  for (const service of services) {
    const domain = service?.domains_id || service?.domain
    if (!domain?.id && !domain?.name) continue
    const key = domain.id ? String(domain.id) : stableKey(domain.name)

    map.set(key, {
      id: domain.id || key,
      name: domain.name || service?.name || String(domain.id),
      service: {id: service?.id || null, name: service?.name || null},
      customer: service?.customer
        ? {id: service.customer.id || null, name: service.customer.name || null}
        : null,
      group: service?.customer?.group
        ? {id: service.customer.group.id || null, name: service.customer.group.name || null}
        : null,
      hasPlesk: Boolean(service?.pleskDomain?.id),
      pleskDomainId: service?.pleskDomain?.id || null,
      pleskIntegrationId: service?.pleskDomain?.integration_id || null,
    })
  }

  return [...map.values()]
}

function buildCommunications({services = []} = {}) {
  const out = []

  for (const service of services) {
    for (const communication of service?.renewalsCommunications || []) {
      out.push({
        id:
          communication?.id ||
          stableKey(service?.id, communication?.type, communication?.communicationDate),
        name: `${service?.name || 'Servizio'} · ${communication?.typeLabel || communication?.type || 'comunicazione'}`,
        type: communication?.type || null,
        typeLabel: communication?.typeLabel || null,
        communicationDate: communication?.communicationDate || null,
        year: toDateYear(communication?.communicationDate),
        service: {id: service?.id || null, name: service?.name || null},
        customer: service?.customer
          ? {id: service.customer.id || null, name: service.customer.name || null}
          : null,
        group: service?.customer?.group
          ? {id: service.customer.group.id || null, name: service.customer.group.name || null}
          : null,
      })
    }
  }

  return out
}

function buildPriceLists({services = []} = {}) {
  const map = new Map()

  const ensure = (ref, kind, ownerId) => {
    if (!ref?.id && !ref?.name) return
    const key = ref.id ? String(ref.id) : stableKey(ref.name)
    if (!map.has(key)) {
      map.set(key, {
        id: ref.id || key,
        name: ref.name || String(ref.id),
        customerIds: new Set(),
        groupIds: new Set(),
      })
    }
    if (kind === 'customer' && ownerId) map.get(key).customerIds.add(String(ownerId))
    if (kind === 'group' && ownerId) map.get(key).groupIds.add(String(ownerId))
  }

  for (const service of services) {
    ensure(service?.customer?.priceListVersionRef, 'customer', service?.customer?.id)
    ensure(service?.customer?.group?.priceListVersionRef, 'group', service?.customer?.group?.id)
  }

  return [...map.values()].map(item => ({
    id: item.id,
    name: item.name,
    customerCount: item.customerIds.size,
    groupCount: item.groupIds.size,
  }))
}

function buildPlanPrices({services = []} = {}) {
  const map = new Map()

  for (const service of services) {
    const priceListVersion =
      service?.customer?.priceListVersionRef ||
      service?.customer?.group?.priceListVersionRef ||
      null

    for (const ref of flattenPlanRefs(service)) {
      const plan = ref.plan || {}
      const planId = relationId(plan)
      const planName = relationName(plan)
      if (!planId && !planName) continue

      const candidates = [
        {
          price: plan?.priceList,
          priceListVersion,
          source: 'applied-price-list',
        },
        {
          price: plan?.priceListStandard,
          priceListVersion: {id: null, name: 'Listino standard', version: null},
          source: 'standard-price-list',
        },
      ]

      for (const candidate of candidates) {
        if (candidate.price === null || candidate.price === undefined || candidate.price === '') {
          continue
        }

        const numericPrice = Number(candidate.price)
        if (!Number.isFinite(numericPrice)) continue

        const versionId = relationId(candidate.priceListVersion)
        const versionName = relationName(candidate.priceListVersion)
        const key = stableKey(
          planId || planName,
          versionId || versionName || candidate.source,
          numericPrice
        )

        if (!map.has(key)) {
          map.set(key, {
            id: key,
            name: [planName || planId, versionName].filter(Boolean).join(' · '),
            price: numericPrice,
            plan: {
              id: planId,
              name: planName,
              kind: ref.kind === 'addon' ? 'addon' : 'base',
            },
            supplier: plan?.supplier
              ? {id: relationId(plan.supplier), name: relationName(plan.supplier)}
              : null,
            priceListVersion: candidate.priceListVersion
              ? {
                  id: versionId,
                  name: versionName,
                  version: candidate.priceListVersion?.version ?? null,
                }
              : null,
            source: candidate.source,
            serviceIds: new Set(),
            subscriptionIds: new Set(),
          })
        }

        const target = map.get(key)
        if (service?.id) target.serviceIds.add(String(service.id))
        if (ref.subscription?.id) target.subscriptionIds.add(String(ref.subscription.id))
      }
    }
  }

  return [...map.values()].map(item => ({
    id: item.id,
    name: item.name,
    price: item.price,
    plan: item.plan,
    supplier: item.supplier,
    priceListVersion: item.priceListVersion,
    source: item.source,
    missingPrice: false,
    serviceCount: item.serviceIds.size,
    subscriptionCount: item.subscriptionIds.size,
  }))
}

function buildServices({services = []} = {}) {
  return services.map(service => ({
    id: service?.id || null,
    name: service?.name || '—',
    customer: service?.customer
      ? {id: service.customer.id || null, name: service.customer.name || null}
      : null,
    group: service?.customer?.group
      ? {id: service.customer.group.id || null, name: service.customer.group.name || null}
      : null,
    domain: service?.domains_id
      ? {id: service.domains_id.id || null, name: service.domains_id.name || null}
      : null,
    providerNames: uniq(
      flattenPlanRefs(service).map(ref => relationName(ref.plan?.supplier)).filter(Boolean)
    ),
    planNames: uniq(flattenPlanRefs(service).map(ref => ref.plan?.name).filter(Boolean)),
    expiryYears: uniq(
      flattenAllSubscriptions(service).map(sub => toDateYear(sub?.endsOn)).filter(Boolean)
    ),
    dontRenew: service?.dontRenew === true,
    autoRenew: service?.autoRenew === true,
    toRenew: service?.toRenew === true,
    toTransfer: Boolean(service?.toTransfer),
    hasPlesk: Boolean(service?.pleskDomain?.id),
  }))
}

const COMMON_NAME_FIELDS = {
  id: {type: 'string', label: 'ID', aliases: ['id', 'identificativo']},
  name: {type: 'string', label: 'nome', aliases: ['nome', 'denominazione']},
}

const definitions = [
  createBaseDefinition({
    id: 'services',
    label: 'servizi',
    singular: 'servizio',
    aliases: ['servizi', 'servizio', 'domini gestiti'],
    fields: {
      ...COMMON_NAME_FIELDS,
      'customer.name': {type: 'string', label: 'cliente', aliases: ['cliente', 'clienti', 'azienda', 'aziende']},
      'group.name': {type: 'string', label: 'gruppo', aliases: ['gruppo', 'gruppi', 'gruppo aziendale', 'gruppi aziendali']},
      'domain.name': {type: 'string', label: 'dominio', aliases: ['dominio', 'domini', 'domain']},
      providerNames: {type: 'string-array', label: 'fornitori', aliases: ['fornitore', 'fornitori', 'provider', 'providers', 'supplier', 'suppliers']},
      planNames: {type: 'string-array', label: 'piani', aliases: ['piano', 'piani', 'plan', 'plans']},
      expiryYears: {type: 'number-array', label: 'anni di scadenza', aliases: ['anno scadenza', 'anni scadenza', 'scadenza', 'scadenze']},
      dontRenew: {type: 'boolean'},
      autoRenew: {type: 'boolean'},
      toRenew: {type: 'boolean'},
      toTransfer: {type: 'boolean'},
      hasPlesk: {type: 'boolean'},
    },
    defaultSort: [{field: 'name', direction: 'asc'}],
    buildRecords: buildServices,
  }),
  createBaseDefinition({
    id: 'providers',
    label: 'fornitori',
    singular: 'fornitore',
    aliases: ['fornitori', 'fornitore', 'provider', 'providers', 'supplier', 'suppliers'],
    fields: {
      ...COMMON_NAME_FIELDS,
      serviceCount: {type: 'number', label: 'numero servizi', aliases: ['servizi', 'numero servizi', 'conteggio servizi', 'service count']},
      subscriptionCount: {type: 'number', label: 'numero sottoscrizioni', aliases: ['sottoscrizioni', 'numero sottoscrizioni', 'abbonamenti', 'subscription count']},
      planCount: {type: 'number', label: 'numero piani', aliases: ['piani', 'numero piani', 'conteggio piani', 'plan count']},
      planNames: {type: 'string-array', label: 'piani', aliases: ['piano', 'piani', 'plan', 'plans']},
      expiryYears: {type: 'number-array', label: 'anni di scadenza', aliases: ['anno scadenza', 'anni scadenza', 'scadenza', 'scadenze']},
      nextExpiry: {type: 'date', label: 'prossima scadenza', aliases: ['prossima scadenza', 'scadenza più vicina', 'next expiry']},
      present: {type: 'boolean'},
    },
    defaultSort: [{field: 'name', direction: 'asc'}],
    catalog: {
      enabled: true,
      fields: ['id', 'name'],
      sortableFields: ['id', 'name'],
    },
    buildRecords: buildProviders,
  }),
  createBaseDefinition({
    id: 'customers',
    label: 'clienti',
    singular: 'cliente',
    aliases: ['clienti', 'cliente', 'aziende', 'azienda'],
    fields: {
      ...COMMON_NAME_FIELDS,
      type: {type: 'string'},
      'group.id': {type: 'string'},
      'group.name': {type: 'string'},
      'priceListVersion.id': {type: 'string'},
      'priceListVersion.name': {type: 'string'},
      'priceListVersion.version': {type: 'number'},
      serviceCount: {type: 'number', label: 'numero servizi', aliases: ['servizi', 'numero servizi', 'conteggio servizi']},
      planCount: {type: 'number', label: 'numero piani', aliases: ['piani', 'numero piani', 'conteggio piani']},
      providerNames: {type: 'string-array', label: 'fornitori', aliases: ['fornitore', 'fornitori', 'provider', 'supplier']},
      expiryYears: {type: 'number-array', label: 'anni di scadenza', aliases: ['anno scadenza', 'anni scadenza', 'scadenza', 'scadenze']},
      expiryDates: {type: 'date'},
    },
    defaultSort: [{field: 'name', direction: 'asc'}],
    catalog: {
      enabled: true,
      fields: [
        'id',
        'name',
        'type',
        'group.id',
        'group.name',
        'priceListVersion.id',
        'priceListVersion.name',
        'priceListVersion.version',
      ],
      sortableFields: ['id', 'name', 'type', 'group.name'],
    },
    buildRecords: buildCustomers,
  }),
  createBaseDefinition({
    id: 'groups',
    label: 'gruppi',
    singular: 'gruppo',
    aliases: ['gruppi', 'gruppo', 'gruppi aziendali', 'gruppo aziendale'],
    fields: {
      ...COMMON_NAME_FIELDS,
      'priceListVersion.id': {type: 'string'},
      'priceListVersion.name': {type: 'string'},
      'priceListVersion.version': {type: 'number'},
      customerCount: {type: 'number', label: 'numero clienti', aliases: ['clienti', 'numero clienti', 'conteggio clienti']},
      serviceCount: {type: 'number', label: 'numero servizi', aliases: ['servizi', 'numero servizi', 'conteggio servizi']},
      providerNames: {type: 'string-array', label: 'fornitori', aliases: ['fornitore', 'fornitori', 'provider', 'supplier']},
      expiryYears: {type: 'number-array', label: 'anni di scadenza', aliases: ['anno scadenza', 'anni scadenza', 'scadenza', 'scadenze']},
    },
    defaultSort: [{field: 'name', direction: 'asc'}],
    catalog: {
      enabled: true,
      fields: [
        'id',
        'name',
        'priceListVersion.id',
        'priceListVersion.name',
        'priceListVersion.version',
      ],
      sortableFields: ['id', 'name'],
    },
    buildRecords: buildGroups,
  }),
  createBaseDefinition({
    id: 'plans',
    label: 'piani',
    singular: 'piano',
    aliases: ['piani', 'piano', 'plan', 'plans', 'offerte'],
    fields: {
      ...COMMON_NAME_FIELDS,
      description: {type: 'string'},
      type: {type: 'string'},
      kind: {type: 'string'},
      duration: {type: 'number'},
      activationFee: {type: 'number'},
      'supplier.id': {type: 'string', label: 'ID fornitore', aliases: ['id fornitore', 'supplier id', 'provider id']},
      'supplier.name': {type: 'string', label: 'fornitore', aliases: ['fornitore', 'fornitori', 'provider', 'supplier']},
      sourceKinds: {type: 'string-array'},
      isAddon: {type: 'boolean'},
      serviceCount: {type: 'number'},
      subscriptionCount: {type: 'number'},
      customerNames: {type: 'string-array'},
      groupNames: {type: 'string-array'},
      resourceNames: {type: 'string-array'},
      serviceTypeInNames: {type: 'string-array'},
      serviceTypeOutNames: {type: 'string-array'},
      expiryYears: {type: 'number-array'},
      prices: {type: 'number-array'},
      priceListVersionNames: {type: 'string-array'},
      missingPrice: {type: 'boolean'},
    },
    defaultSort: [{field: 'name', direction: 'asc'}],
    catalog: {
      enabled: true,
      fields: [
        'id',
        'name',
        'type',
        'kind',
        'description',
        'duration',
        'activationFee',
        'supplier.id',
        'supplier.name',
        'resourceNames',
        'serviceTypeInNames',
        'serviceTypeOutNames',
        'prices',
        'priceListVersionNames',
      ],
      sortableFields: [
        'id',
        'name',
        'type',
        'kind',
        'duration',
        'activationFee',
        'supplier.name',
      ],
    },
    buildRecords: context => buildPlans(context),
  }),
  createBaseDefinition({
    id: 'addons',
    label: 'add-on',
    singular: 'add-on',
    aliases: ['addon', 'add-on', 'add on', 'componenti aggiuntivi'],
    fields: {
      ...COMMON_NAME_FIELDS,
      description: {type: 'string'},
      type: {type: 'string'},
      kind: {type: 'string'},
      duration: {type: 'number'},
      activationFee: {type: 'number'},
      'supplier.id': {type: 'string', label: 'ID fornitore', aliases: ['id fornitore', 'supplier id', 'provider id']},
      'supplier.name': {type: 'string', label: 'fornitore', aliases: ['fornitore', 'fornitori', 'provider', 'supplier']},
      serviceCount: {type: 'number'},
      subscriptionCount: {type: 'number'},
      customerNames: {type: 'string-array'},
      groupNames: {type: 'string-array'},
      resourceNames: {type: 'string-array'},
      serviceTypeInNames: {type: 'string-array'},
      serviceTypeOutNames: {type: 'string-array'},
      prices: {type: 'number-array'},
      priceListVersionNames: {type: 'string-array'},
      missingPrice: {type: 'boolean'},
    },
    defaultSort: [{field: 'name', direction: 'asc'}],
    catalog: {
      enabled: true,
      fields: [
        'id',
        'name',
        'type',
        'kind',
        'description',
        'duration',
        'activationFee',
        'supplier.id',
        'supplier.name',
        'resourceNames',
        'serviceTypeInNames',
        'serviceTypeOutNames',
        'prices',
        'priceListVersionNames',
      ],
      sortableFields: [
        'id',
        'name',
        'type',
        'kind',
        'duration',
        'activationFee',
        'supplier.name',
      ],
    },
    buildRecords: context => buildPlans(context, {addonsOnly: true}),
  }),
  createBaseDefinition({
    id: 'plan-prices',
    label: 'prezzi dei piani',
    singular: 'prezzo del piano',
    aliases: [
      'prezzi dei piani',
      'prezzo del piano',
      'prezzi di listino',
      'prezzo di listino',
      'tariffe dei piani',
    ],
    fields: {
      ...COMMON_NAME_FIELDS,
      price: {type: 'number'},
      missingPrice: {type: 'boolean'},
      'plan.id': {type: 'string'},
      'plan.name': {type: 'string'},
      'plan.kind': {type: 'string'},
      'supplier.id': {type: 'string', label: 'ID fornitore', aliases: ['id fornitore', 'supplier id', 'provider id']},
      'supplier.name': {type: 'string', label: 'fornitore', aliases: ['fornitore', 'fornitori', 'provider', 'supplier']},
      'priceListVersion.id': {type: 'string'},
      'priceListVersion.name': {type: 'string'},
      'priceListVersion.version': {type: 'number'},
      serviceCount: {type: 'number'},
      subscriptionCount: {type: 'number'},
    },
    defaultSort: [
      {field: 'plan.name', direction: 'asc'},
      {field: 'priceListVersion.version', direction: 'desc'},
    ],
    catalog: {
      enabled: true,
      fields: [
        'id',
        'name',
        'price',
        'plan.id',
        'plan.name',
        'plan.kind',
        'supplier.id',
        'supplier.name',
        'priceListVersion.id',
        'priceListVersion.name',
        'priceListVersion.version',
      ],
      sortableFields: [
        'id',
        'name',
        'price',
        'plan.name',
        'supplier.name',
        'priceListVersion.name',
        'priceListVersion.version',
      ],
    },
    buildRecords: buildPlanPrices,
  }),
  createBaseDefinition({
    id: 'resources',
    label: 'tipi di risorsa',
    singular: 'risorsa',
    aliases: ['risorse', 'risorsa', 'tipi di risorsa', 'tipo di risorsa', 'resource'],
    fields: {
      ...COMMON_NAME_FIELDS,
      key: {type: 'string'},
      category: {type: 'string'},
      unitOfMeasurement: {type: 'string'},
      planCount: {type: 'number'},
      planNames: {type: 'string-array'},
      supplierNames: {type: 'string-array'},
      amounts: {type: 'number-array'},
    },
    defaultSort: [{field: 'name', direction: 'asc'}],
    catalog: {
      enabled: true,
      fields: ['id', 'name', 'key', 'category', 'unitOfMeasurement'],
      sortableFields: ['id', 'name', 'key', 'category', 'unitOfMeasurement'],
    },
    buildRecords: buildResources,
  }),
  createBaseDefinition({
    id: 'service-types',
    label: 'tipi di servizio',
    singular: 'tipo di servizio',
    aliases: ['tipi di servizio', 'tipo di servizio', 'categorie di servizio'],
    fields: {
      ...COMMON_NAME_FIELDS,
      'macro.id': {type: 'string'},
      'macro.name': {type: 'string'},
      serviceCount: {type: 'number'},
      planInCount: {type: 'number'},
      planOutCount: {type: 'number'},
    },
    defaultSort: [{field: 'name', direction: 'asc'}],
    catalog: {
      enabled: true,
      fields: ['id', 'name', 'macro.id', 'macro.name'],
      sortableFields: ['id', 'name', 'macro.name'],
    },
    buildRecords: buildServiceTypes,
  }),
  createBaseDefinition({
    id: 'macro-service-types',
    label: 'macro tipi di servizio',
    singular: 'macro tipo di servizio',
    aliases: ['macro tipi di servizio', 'macro tipo di servizio', 'macro categorie di servizio'],
    fields: {
      ...COMMON_NAME_FIELDS,
      serviceTypeCount: {type: 'number'},
      serviceCount: {type: 'number'},
      planInCount: {type: 'number'},
      planOutCount: {type: 'number'},
    },
    defaultSort: [{field: 'name', direction: 'asc'}],
    catalog: {
      enabled: true,
      fields: ['id', 'name'],
      sortableFields: ['id', 'name'],
    },
    buildRecords: buildMacroServiceTypes,
  }),
  createBaseDefinition({
    id: 'subscriptions',
    label: 'sottoscrizioni',
    singular: 'sottoscrizione',
    aliases: ['sottoscrizioni', 'sottoscrizione', 'abbonamenti', 'abbonamento'],
    fields: {
      ...COMMON_NAME_FIELDS,
      kind: {type: 'string'},
      'service.id': {type: 'string', label: 'ID servizio', aggregateLabel: 'servizi distinti', aliases: ['id servizio', 'service id']},
      'service.name': {type: 'string', label: 'servizio', aliases: ['servizio', 'servizi']},
      'domain.id': {type: 'string', label: 'ID dominio', aggregateLabel: 'domini distinti', aliases: ['id dominio', 'domain id']},
      'domain.name': {type: 'string', label: 'dominio', aliases: ['dominio', 'domini', 'domain']},
      serviceHasPlesk: {type: 'boolean', label: 'collegamento Plesk', aliases: ['collegato a Plesk', 'Plesk']},
      serviceSpacePercent: {type: 'number', label: 'spazio utilizzato percentuale', aliases: ['spazio utilizzato', 'percentuale spazio', 'uso disco']},
      serviceSpaceFull: {type: 'boolean', label: 'spazio esaurito', aliases: ['spazio esaurito', 'spazio pieno', 'disco pieno']},
      serviceDontRenew: {type: 'boolean', label: 'non rinnovare', aliases: ['non rinnovare']},
      serviceToTransfer: {type: 'boolean', label: 'da trasferire', aliases: ['da trasferire', 'trasferimento']},
      'customer.id': {type: 'string', label: 'ID cliente', aggregateLabel: 'clienti distinti', aliases: ['id cliente', 'customer id']},
      'customer.name': {type: 'string', label: 'cliente', aliases: ['cliente', 'clienti', 'azienda', 'aziende']},
      'group.id': {type: 'string', label: 'ID gruppo', aggregateLabel: 'gruppi distinti', aliases: ['id gruppo', 'group id']},
      'group.name': {type: 'string', label: 'gruppo', aliases: ['gruppo', 'gruppi', 'gruppo aziendale']},
      'plan.id': {type: 'string', label: 'ID piano', aggregateLabel: 'piani distinti', aliases: ['id piano', 'plan id']},
      'plan.name': {type: 'string', label: 'piano', aliases: ['piano', 'piani', 'plan', 'plans']},
      'supplier.id': {type: 'string', label: 'ID fornitore', aggregateLabel: 'fornitori distinti', aliases: ['id fornitore', 'supplier id', 'provider id']},
      'supplier.name': {type: 'string', label: 'fornitore', aliases: ['fornitore', 'fornitori', 'provider', 'supplier']},
      startsOn: {type: 'date', label: 'data inizio', aliases: ['inizio', 'data inizio', 'starts on']},
      endsOn: {type: 'date', label: 'scadenza', aliases: ['scadenza', 'data scadenza', 'fine', 'ends on']},
      expiryYear: {type: 'number', label: 'anno di scadenza', aliases: ['anno scadenza', 'anno di scadenza']},
      addonCount: {type: 'number', label: 'numero add-on', aliases: ['add-on', 'addon', 'numero add-on']},
    },
    defaultSort: [{field: 'endsOn', direction: 'asc'}],
    analytics: {
      grain: 'subscription',
      timeField: 'endsOn',
      relations: {
        services: {
          idField: 'service.id',
          labelField: 'service.name',
          filters: [{field: 'service.id', operator: 'exists'}],
        },
        domains: {
          idField: 'domain.id',
          labelField: 'domain.name',
          filters: [{field: 'domain.id', operator: 'exists'}],
        },
        providers: {
          idField: 'supplier.id',
          labelField: 'supplier.name',
          filters: [
            {field: 'kind', operator: 'equals', value: 'supplier'},
            {field: 'supplier.name', operator: 'exists'},
          ],
        },
        customers: {
          idField: 'customer.id',
          labelField: 'customer.name',
          filters: [
            {field: 'kind', operator: 'equals', value: 'customer'},
            {field: 'customer.name', operator: 'exists'},
          ],
        },
        groups: {
          idField: 'group.id',
          labelField: 'group.name',
          filters: [
            {field: 'kind', operator: 'equals', value: 'customer'},
            {field: 'group.name', operator: 'exists'},
          ],
        },
        plans: {idField: 'plan.id', labelField: 'plan.name'},
      },
    },
    buildRecords: buildSubscriptions,
  }),
  createBaseDefinition({
    id: 'domains',
    label: 'domini',
    singular: 'dominio',
    aliases: ['domini', 'dominio', 'domain'],
    fields: {
      ...COMMON_NAME_FIELDS,
      'service.name': {type: 'string'},
      'customer.name': {type: 'string'},
      'group.name': {type: 'string'},
      hasPlesk: {type: 'boolean'},
      pleskDomainId: {type: 'string'},
      pleskIntegrationId: {type: 'string'},
    },
    defaultSort: [{field: 'name', direction: 'asc'}],
    buildRecords: buildDomains,
  }),
  createBaseDefinition({
    id: 'communications',
    label: 'comunicazioni',
    singular: 'comunicazione',
    aliases: ['comunicazioni', 'comunicazione', 'mail inviate', 'email inviate'],
    fields: {
      ...COMMON_NAME_FIELDS,
      type: {type: 'string'},
      typeLabel: {type: 'string'},
      communicationDate: {type: 'date'},
      year: {type: 'number'},
      'service.name': {type: 'string'},
      'customer.name': {type: 'string'},
      'group.name': {type: 'string'},
    },
    defaultSort: [{field: 'communicationDate', direction: 'desc'}],
    buildRecords: buildCommunications,
  }),
  createBaseDefinition({
    id: 'price-lists',
    label: 'listini',
    singular: 'listino',
    aliases: ['listini', 'listino', 'versioni listino', 'versione listino'],
    fields: {
      ...COMMON_NAME_FIELDS,
      version: {type: 'number'},
      customerCount: {type: 'number'},
      groupCount: {type: 'number'},
    },
    defaultSort: [{field: 'name', direction: 'asc'}],
    catalog: {
      enabled: true,
      fields: ['id', 'name', 'version'],
      sortableFields: ['id', 'name', 'version'],
    },
    buildRecords: buildPriceLists,
  }),
]

const registry = new Map(definitions.map(definition => [definition.id, definition]))

function splitFieldId(value = '') {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getFieldSemanticTerms(fieldId = '', config = {}) {
  return [...new Set([
    fieldId,
    splitFieldId(fieldId),
    config?.label,
    ...(Array.isArray(config?.aliases) ? config.aliases : []),
  ])]
    .filter(Boolean)
    .map(normalizeText)
    .filter(Boolean)
}

export function findReadEntityFieldByAlias(entityOrId, value = '') {
  const definition =
    typeof entityOrId === 'string'
      ? registry.get(String(entityOrId || '').trim())
      : entityOrId

  if (!definition) return null

  const needle = normalizeText(value)
  if (!needle) return null

  const matches = Object.entries(definition.fields || {})
    .map(([id, config]) => ({
      id,
      config,
      terms: getFieldSemanticTerms(id, config),
    }))
    .filter(item => item.terms.includes(needle))

  return matches.length === 1 ? {id: matches[0].id, ...matches[0].config} : null
}

export function getReadEntityRegistry() {
  return registry
}

export function getReadEntityDefinitions() {
  return definitions.map(definition => ({
    id: definition.id,
    label: definition.label,
    singular: definition.singular,
    aliases: definition.aliases,
    fields: Object.fromEntries(
      Object.entries(definition.fields || {}).map(([id, config]) => [
        id,
        {
          ...config,
          label: config?.label || splitFieldId(id),
          aliases: Array.isArray(config?.aliases) ? config.aliases : [],
        },
      ])
    ),
    catalog: definition.catalog
      ? {
          enabled: definition.catalog.enabled === true,
          fields: definition.catalog.fields,
          sortableFields: definition.catalog.sortableFields,
        }
      : null,
    analytics: definition.analytics
      ? {
          grain: definition.analytics.grain || definition.id,
          timeField: definition.analytics.timeField || null,
          relations: definition.analytics.relations || {},
        }
      : null,
  }))
}

export function findReadEntityByAlias(value = '') {
  const text = normalizeText(value)
  if (!text) return null

  const matches = definitions
    .flatMap(definition =>
      definition.aliases.map(alias => ({
        definition,
        alias,
        normalizedAlias: normalizeText(alias),
      }))
    )
    .filter(entry => new RegExp(`\\b${entry.normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))
    .sort((a, b) => b.normalizedAlias.length - a.normalizedAlias.length)

  return matches[0]?.definition || null
}

export function buildReadEntityRecords(entityId, context = {}) {
  const definition = registry.get(entityId)
  if (!definition) return []
  return definition.buildRecords(context)
}

export function canExecuteReadQueryFromCatalog(plan = {}) {
  const definition = registry.get(String(plan?.entity || '').trim())
  const catalog = definition?.catalog

  if (!catalog?.enabled) return false

  const allowedFields = new Set(catalog.fields || [])
  const sortableFields = new Set(catalog.sortableFields || [])
  const filters = Array.isArray(plan?.filters) ? plan.filters : []
  const sort = Array.isArray(plan?.sort) ? plan.sort : []

  return (
    filters.every(filter => allowedFields.has(String(filter?.field || '').trim())) &&
    sort.every(entry => sortableFields.has(String(entry?.field || '').trim()))
  )
}
