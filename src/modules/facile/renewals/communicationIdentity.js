import {operationalCustomer} from './customerReferences.js'

export function historicalAttributionNote(item) {
  return item?.customerSource === 'current-fallback' || item?.groupSource === 'current-fallback'
    ? 'Attribuzione cliente/gruppo derivata dai dati correnti; identità storica non verificabile.' : null
}

export function historicalCommunicationIdentity(communication, service) {
  return communication?.historicalIdentity ?? resolveHistoricalIdentity(communication,
    {id: service?.id, operationalCustomer: operationalCustomer(service)})
}

function id(value) {
	return value && typeof value === 'object' ? value.id ?? null : value ?? null
}

// The fallback is deliberately operational for pre-separation records. It is
// derived, never proof of the recipient/customer at the time of delivery.
export function resolveHistoricalIdentity(communication, currentService = null) {
	const context = communication?.generation_context ?? communication?.generationContext
	const serviceId = id(communication?.services_id) ?? communication?.serviceId ??
		context?.commercialSnapshot?.serviceId ?? currentService?.id
	const snapshots = Array.isArray(context?.commercialSnapshot?.services) ? context.commercialSnapshot.services : []
	const snapshot = snapshots.find(s => s && String(s.serviceId) === String(serviceId)) ??
		(serviceId == null && snapshots.length === 1 ? snapshots[0] : null)
	if (snapshot) return {
		customerId: snapshot.commercialCustomerId ?? null,
		customerName: snapshot.commercialCustomerName ?? null,
		groupId: snapshot.commercialGroupId ?? null,
		groupName: snapshot.commercialGroupName ?? null,
		customerSource: snapshot.customerSource ?? 'snapshot', groupSource: snapshot.groupSource ?? 'snapshot',
	}
	const scope = context?.scope
	const current = Object.hasOwn(currentService ?? {}, 'operationalCustomer') ? currentService.operationalCustomer
		: currentService?.customers_id ?? (Object.hasOwn(currentService ?? {}, 'commercialCustomerId') ? null : currentService?.customer ?? null)
	const group = current?.customers_groups_id ?? current?.group ?? null
	if (scope?.type === 'customer' && scope.id) return {
		customerId: scope.id, customerName: scope.label ?? null,
		groupId: null, groupName: null, customerSource: 'stored', groupSource: 'unavailable',
	}
	return {
		customerId: id(current), customerName: current?.name ?? null,
		groupId: scope?.type === 'group' && scope.id ? scope.id : id(group),
		groupName: scope?.type === 'group' && scope.id ? scope.label ?? null : group?.name ?? null,
		customerSource: 'current-fallback',
		groupSource: scope?.type === 'group' && scope.id ? 'stored' : 'current-fallback',
	}
}

