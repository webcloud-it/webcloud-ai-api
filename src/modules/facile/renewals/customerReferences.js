// `customer` is commercial in current renewals payloads. Older API payloads remain readable.
export function commercialCustomer(service) {
  const separated = ['commercialCustomer', 'commercialCustomerId', 'explicitCommercialCustomerId',
    'operationalCustomer', 'operationalCustomerId'].some(field => Object.hasOwn(service ?? {}, field))
  if (!separated) return service?.customer ?? null
  const customer = service?.commercialCustomer
  if (!Object.hasOwn(service ?? {}, 'commercialCustomer') || !customer?.id ||
    (service.commercialCustomerId && customer.id !== service.commercialCustomerId) ||
    (service.explicitCommercialCustomerId && customer.id !== service.explicitCommercialCustomerId)) {
    const error = new Error('Cliente commerciale non leggibile: payload servizi incompleto o incoerente')
    error.statusCode = 403
    throw error
  }
  return customer
}

export function operationalCustomer(service) {
  if (Object.hasOwn(service ?? {}, 'operationalCustomer')) return service.operationalCustomer
  // Compatibility is restricted to old contracts with no commercial separation fields.
  return ['commercialCustomer', 'commercialCustomerId', 'explicitCommercialCustomerId', 'operationalCustomerId']
    .some(field => Object.hasOwn(service ?? {}, field)) ? null : service?.customer ?? null
}

export function normalizeRenewalsService(service) {
  const customer = commercialCustomer(service)
  return customer === service?.customer ? service : {...service, customer}
}
