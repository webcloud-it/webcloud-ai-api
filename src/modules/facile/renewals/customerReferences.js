// `customer` is commercial in current renewals payloads. Older API payloads remain readable.
export function commercialCustomer(service) {
  return Object.hasOwn(service ?? {}, 'commercialCustomer') ? service.commercialCustomer : service?.customer ?? null
}

export function operationalCustomer(service) {
  if (Object.hasOwn(service ?? {}, 'operationalCustomer')) return service.operationalCustomer
  // Compatibility is restricted to old contracts with no commercial separation fields.
  return Object.hasOwn(service ?? {}, 'commercialCustomerId') ? null : service?.customer ?? null
}

export function normalizeRenewalsService(service) {
  if (!Object.hasOwn(service ?? {}, 'commercialCustomer')) return service
  return {...service, customer: commercialCustomer(service)}
}
