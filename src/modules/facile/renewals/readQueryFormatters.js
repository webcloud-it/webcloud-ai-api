function pluralize(value, singular, plural) {
  return `${value} ${Number(value) === 1 ? singular : plural}`
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('it-IT').format(date)
}

function formatPrice(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'

  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
  }).format(number)
}

function formatAmountList(values = []) {
  const normalized = values
    .filter(value => value !== null && value !== undefined && value !== '')
    .slice(0, 8)
    .map(value => String(value))

  return normalized.length ? normalized.join(', ') : '—'
}

function formatProvider(item) {
  const details = [
    pluralize(item.serviceCount || 0, 'servizio', 'servizi'),
    pluralize(item.subscriptionCount || 0, 'sottoscrizione', 'sottoscrizioni'),
    pluralize(item.planCount || 0, 'piano', 'piani'),
  ]
  if (item.nextExpiry) details.push(`prossima scadenza ${formatDate(item.nextExpiry)}`)
  return `- ${item.name} | ${details.join(' | ')}`
}

function formatPlan(item) {
  const details = []
  if (item.supplier?.name) details.push(`fornitore ${item.supplier.name}`)
  if (item.duration != null) details.push(`durata ${item.duration} mesi`)
  details.push(pluralize(item.serviceCount || 0, 'servizio', 'servizi'))
  if (item.resourceNames?.length) details.push(`risorse: ${item.resourceNames.slice(0, 4).join(', ')}`)
  if (item.prices?.length) details.push(`prezzi da ${formatPrice(Math.min(...item.prices))}`)
  if (item.missingPrice) details.push('prezzo mancante')
  return `- ${item.name} | ${details.join(' | ')}`
}

function formatAddon(item) {
  const details = []
  if (item.supplier?.name) details.push(`fornitore ${item.supplier.name}`)
  details.push(pluralize(item.serviceCount || 0, 'servizio', 'servizi'))
  if (item.resourceNames?.length) details.push(`risorse: ${item.resourceNames.slice(0, 4).join(', ')}`)
  if (item.prices?.length) details.push(`prezzi da ${formatPrice(Math.min(...item.prices))}`)
  if (item.missingPrice) details.push('prezzo mancante')
  return `- ${item.name} | ${details.join(' | ')}`
}

function formatPlanPrice(item) {
  const details = []
  if (item.priceListVersion?.name) {
    const name = String(item.priceListVersion.name)
    const baseLabel = /^listino\b/i.test(name) ? name : `listino ${name}`
    const version = item.priceListVersion.version
    const versionLabel =
      version != null && !name.includes(String(version)) ? ` v.${version}` : ''

    details.push(`${baseLabel}${versionLabel}`)
  }
  if (item.supplier?.name) details.push(`fornitore ${item.supplier.name}`)
  if (item.plan?.kind === 'addon') details.push('add-on')
  details.push(item.price == null ? 'prezzo mancante' : formatPrice(item.price))

  return `- ${item.plan?.name || item.name || '—'} | ${details.join(' | ')}`
}

function formatResource(item, result = {}) {
  const details = [pluralize(item.planCount || 0, 'piano', 'piani')]
  const planFilter = result?.plan?.filters?.find(filter => filter.field === 'planNames')
  const matchingUsages = planFilter
    ? (item.planUsages || []).filter(usage =>
        String(usage?.planName || '').toLowerCase().includes(String(planFilter.value || '').toLowerCase())
      )
    : []
  const amounts = matchingUsages.length
    ? [...new Set(matchingUsages.flatMap(usage => usage.amounts || []))]
    : item.amounts || []
  if (amounts.length) details.push(`valori: ${formatAmountList(amounts)}`)
  if (matchingUsages.length) {
    details.push(`piano: ${matchingUsages.map(usage => usage.planName).filter(Boolean).join(', ')}`)
  }
  if (item.supplierNames?.length) details.push(`fornitori: ${item.supplierNames.slice(0, 4).join(', ')}`)
  return `- ${item.name} | ${details.join(' | ')}`
}

function formatCustomer(item) {
  const details = []
  if (item.group?.name) details.push(`gruppo ${item.group.name}`)
  details.push(pluralize(item.serviceCount || 0, 'servizio', 'servizi'))
  details.push(pluralize(item.planCount || 0, 'piano', 'piani'))
  return `- ${item.name} | ${details.join(' | ')}`
}

function formatGroup(item) {
  return `- ${item.name} | ${pluralize(item.customerCount || 0, 'cliente', 'clienti')} | ${pluralize(item.serviceCount || 0, 'servizio', 'servizi')}`
}

function formatServiceType(item) {
  const details = []
  if (item.macro?.name) details.push(`macro ${item.macro.name}`)
  details.push(pluralize(item.serviceCount || 0, 'servizio', 'servizi'))
  details.push(`${item.planInCount || 0} piani in ingresso`)
  details.push(`${item.planOutCount || 0} piani in uscita`)
  return `- ${item.name} | ${details.join(' | ')}`
}

function formatMacroServiceType(item) {
  return `- ${item.name} | ${pluralize(item.serviceTypeCount || 0, 'tipo', 'tipi')} | ${pluralize(item.serviceCount || 0, 'servizio', 'servizi')}`
}

function formatSubscription(item) {
  const details = [item.kind === 'supplier' ? 'fornitore' : 'cliente']
  if (item.service?.name) details.push(`servizio ${item.service.name}`)
  if (item.plan?.name) details.push(`piano ${item.plan.name}`)
  if (item.supplier?.name) details.push(`fornitore ${item.supplier.name}`)
  if (item.endsOn) details.push(`scadenza ${formatDate(item.endsOn)}`)
  return `- ${item.name} | ${details.join(' | ')}`
}

function formatDomain(item) {
  const details = []
  if (item.service?.name && item.service.name !== item.name) details.push(`servizio ${item.service.name}`)
  if (item.customer?.name) details.push(`cliente ${item.customer.name}`)
  details.push(item.hasPlesk ? 'Plesk collegato' : 'Plesk non collegato')
  return `- ${item.name} | ${details.join(' | ')}`
}

function formatCommunication(item) {
  const details = []
  if (item.typeLabel || item.type) details.push(item.typeLabel || `tipo ${item.type}`)
  if (item.communicationDate) details.push(formatDate(item.communicationDate))
  if (item.service?.name) details.push(`servizio ${item.service.name}`)
  if (item.customer?.name) details.push(`cliente ${item.customer.name}`)
  return `- ${item.name} | ${details.join(' | ')}`
}

function formatPriceList(item) {
  return `- ${item.name} | ${pluralize(item.customerCount || 0, 'cliente', 'clienti')} | ${pluralize(item.groupCount || 0, 'gruppo', 'gruppi')}`
}

function formatGeneric(item) {
  const name = item?.name || item?.label || item?.id || '—'
  return `- ${name}`
}

const formatters = {
  providers: formatProvider,
  plans: formatPlan,
  addons: formatAddon,
  'plan-prices': formatPlanPrice,
  resources: formatResource,
  customers: formatCustomer,
  groups: formatGroup,
  'service-types': formatServiceType,
  'macro-service-types': formatMacroServiceType,
  subscriptions: formatSubscription,
  domains: formatDomain,
  communications: formatCommunication,
  'price-lists': formatPriceList,
}

function getEntityLabel(result = {}, value = 0) {
  return Number(value) === 1
    ? result.entitySingular || result.entityLabel
    : result.entityLabel
}

function buildSourceSuffix(result = {}) {
  return result.dataSource === 'catalog'
    ? ' nel catalogo completo'
    : ' nei dati operativi dei servizi'
}

function appendUsage(line, item = {}, result = {}) {
  if (result.dataSource !== 'catalog' || !item?.usage?.status) return line

  const label =
    item.usage.status === 'used'
      ? 'utilizzato nei servizi'
      : 'non utilizzato nei servizi'

  return `${line} | ${label}`
}



const detailEntityHeadings = {
  providers: 'del fornitore',
  plans: 'del piano',
  addons: "dell’add-on",
  'plan-prices': 'del prezzo del piano',
  resources: 'della risorsa',
  customers: 'del cliente',
  groups: 'del gruppo',
  'service-types': 'del tipo di servizio',
  'macro-service-types': 'del macro tipo di servizio',
  subscriptions: 'della sottoscrizione',
  domains: 'del dominio',
  communications: 'della comunicazione',
  'price-lists': 'del listino',
}

function getDetailEntityHeading(result = {}) {
  if (detailEntityHeadings[result.entity]) return detailEntityHeadings[result.entity]

  const singular = result.entitySingular || result.entityLabel || 'entità'
  return `dell’entità ${singular}`
}

function getDetailItemName(item = {}, result = {}) {
  if (result.entity === 'plan-prices') {
    return item?.plan?.name || item?.name || item?.id || '—'
  }

  return item?.name || item?.label || item?.id || '—'
}

function buildDetailReply(result = {}, formatter = formatGeneric) {
  if (result.total === 1 && result.items?.length === 1) {
    const item = result.items[0]
    const line = appendUsage(formatter(item, result), item, result).replace(/^[-•]\s*/, '')

    return `Dettagli ${getDetailEntityHeading(result)} ${getDetailItemName(item, result)}${buildSourceSuffix(result)}:

${line}`
  }

  const start = result.offset + 1
  const end = result.offset + result.shown
  const lines = result.items.map(item => appendUsage(formatter(item, result), item, result))
  const tail = result.hasMore
    ? `

Puoi chiedermi "altri ${result.limit}" per continuare.`
    : ''

  return `Ho trovato ${result.total} possibili ${getEntityLabel(result, result.total)}${buildSourceSuffix(result)}. Ti mostro i risultati ${start}-${end}.

${lines.join('\n')}${tail}`
}

export function buildReadQueryReply(result = {}) {
  if (!result?.ok) {
    return result?.error || 'Non è stato possibile eseguire la richiesta.'
  }

  if (result.operation === 'count') {
    return `Ho trovato ${result.total} ${getEntityLabel(result, result.total)}${buildSourceSuffix(result)}.`
  }

  if (!result.total) {
    return `Non ho trovato ${result.entityLabel} corrispondenti ai filtri richiesti${buildSourceSuffix(result)}.`
  }

  const formatter = formatters[result.entity] || formatGeneric

  if (result.operation === 'detail') {
    return buildDetailReply(result, formatter)
  }

  const start = result.offset + 1
  const end = result.offset + result.shown
  const heading =
    result.total > result.shown || result.offset > 0
      ? `Ho trovato ${result.total} ${getEntityLabel(result, result.total)}${buildSourceSuffix(result)}. Ti mostro i risultati ${start}-${end}.`
      : `Ho trovato ${result.total} ${getEntityLabel(result, result.total)}${buildSourceSuffix(result)}.`
  const lines = result.items.map(item => appendUsage(formatter(item, result), item, result))
  const tail = result.hasMore
    ? `\n\nPuoi chiedermi "altri ${result.limit}" per continuare.`
    : ''

  return `${heading}\n\n${lines.join('\n')}${tail}`
}
