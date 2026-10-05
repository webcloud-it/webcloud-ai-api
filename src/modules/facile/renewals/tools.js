import {getAllServices, getSettings} from './service.js'
import {buildStructuredServiceListPayload} from './serviceQueries.js'
import {formatRecordedDateTime} from '../../../utils/formatters.js'
import {ToolContractError} from '../../../core/tools/toolContract.js'

const RENEWALS_SEARCH_SERVICES_NAME = 'renewals_search_services'
const RENEWALS_SEARCH_COMMUNICATIONS_NAME = 'renewals_search_communications'

const toolDefinition = {
  type: 'function',
  function: {
    name: RENEWALS_SEARCH_SERVICES_NAME,
    description:
      'Cerca servizi interni nel pannello Rinnovi/CRM. Usa solo i filtri richiesti.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerOrGroup: {type: 'string', description: 'Cliente o gruppo.'},
        serviceType: {type: 'string', description: 'Tipo servizio.'},
        plan: {type: 'string', description: 'Piano.'},
        supplier: {type: 'string', description: 'Fornitore.'},
        expiresYear: {
          type: 'integer',
          minimum: 2000,
          maximum: 2100,
          description: 'Anno scadenza cliente.',
        },
        flags: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'string',
            enum: [
              'to-renew',
              'to-transfer',
              'auto-renew',
              'no-auto-renew',
              'has-plesk',
              'no-plesk',
              'space-full',
              'space-low',
              'has-communications',
              'no-communications',
            ],
          },
          description: 'Filtri positivi. NON RINNOVARE usa dontRenewMode.',
        },
        dontRenewMode: {
          type: 'string',
          enum: ['any', 'exclude', 'only'],
          description: 'NON RINNOVARE: exclude=escludi, only=solo, any=nessun filtro.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Limite risultati.',
        },
        offset: {type: 'integer', minimum: 0, description: 'Offset lista.'},
      },
      required: [],
    },
  },
}




const communicationToolDefinition = {
  type: 'function',
  function: {
    name: RENEWALS_SEARCH_COMMUNICATIONS_NAME,
    description:
      'Consulta le comunicazioni di rinnovo registrate e i loro metadati verificati: data, tipo, destinatario, oggetto, modalità di invio, servizio e cliente/gruppo. Per consultare i metadati della comunicazione più recente usa latest; sentAutomatically è soltanto un filtro di ricerca.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerOrGroup: {type: 'string', description: 'Cliente o gruppo.'},
        service: {type: 'string', description: 'Nome servizio.'},
        sentAutomatically: {type: 'boolean', description: 'Filtro: cerca soltanto invii automatici (true) o manuali (false). Omettilo per consultare la modalità di una comunicazione.'},
        latest: {type: 'boolean', description: 'true per la comunicazione più recente.'},
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Limite risultati.',
        },
      },
      required: [],
    },
  },
}

function normalizeComparable(value = '') {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('it')
    .trim()
}

function normalizeCommunicationText(value) {
  if (!['string', 'number'].includes(typeof value)) return undefined
  const normalized = String(value).trim()
  return normalized || undefined
}

function parseCommunicationDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function matchesCommunicationScope(
  service = {},
  {customerOrGroup = null, serviceName = null} = {}
) {
  const scope = normalizeComparable(customerOrGroup)
  const serviceTerm = normalizeComparable(serviceName)

  if (scope) {
    const values = [
      service?.customer?.name,
      service?.customer?.businessName,
      service?.customer?.group?.name,
    ]
      .map(normalizeComparable)
      .filter(Boolean)

    if (!values.some(value => value.includes(scope))) return false
  }

  if (serviceTerm) {
    const name = normalizeComparable(service?.name)
    if (!name.includes(serviceTerm)) return false
  }

  return true
}

function normalizeRenewalCommunication(service = {}, communication = {}) {
  const fields = {
    id: normalizeCommunicationText(communication?.id),
    communicationDate: normalizeCommunicationText(communication?.communicationDate),
    type: normalizeCommunicationText(communication?.type),
    typeLabel: normalizeCommunicationText(communication?.typeLabel),
    sentAutomatically: typeof communication?.sentAutomatically === 'boolean' ? communication.sentAutomatically : undefined,
    to: normalizeCommunicationText(communication?.to),
    subject: normalizeCommunicationText(communication?.subject),
    serviceId: normalizeCommunicationText(service?.id),
    serviceName: normalizeCommunicationText(service?.name),
    customerId: normalizeCommunicationText(service?.customer?.id),
    customerName: normalizeCommunicationText(service?.customer?.name || service?.customer?.businessName),
    groupId: normalizeCommunicationText(service?.customer?.group?.id),
    groupName: normalizeCommunicationText(service?.customer?.group?.name),
  }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

async function searchRenewalCommunications({
  customerOrGroup = null,
  service = null,
  sentAutomatically = null,
  latest = false,
  limit = 20,
} = {}) {
  const services = await getAllServices()
  const matches = []
  let completeHistory = true
  let missingSendingMode = false

  for (const item of Array.isArray(services) ? services : []) {
    if (!matchesCommunicationScope(item, {customerOrGroup, serviceName: service})) continue

    const hasHistory = Array.isArray(item?.renewalsCommunicationsHistory)
    if (!hasHistory) completeHistory = false
    const communications = hasHistory ? item.renewalsCommunicationsHistory : item?.renewalsCommunications || []

    for (const communication of Array.isArray(communications) ? communications : []) {
      const normalized = normalizeRenewalCommunication(item, communication)
      if (typeof normalized.sentAutomatically !== 'boolean') missingSendingMode = true

      if (
        typeof sentAutomatically === 'boolean' &&
        normalized.sentAutomatically !== sentAutomatically
      ) {
        continue
      }

      matches.push(normalized)
    }
  }

  if (typeof sentAutomatically === 'boolean' && missingSendingMode) {
    throw new ToolContractError('COMMUNICATIONS_FIELD_UNAVAILABLE', 'Il datasource non fornisce la modalità di invio per tutte le comunicazioni: il filtro automatico/manuale non è verificabile.')
  }

  matches.sort((left, right) => {
    const leftCommunication = parseCommunicationDate(left.communicationDate)?.getTime() || 0
    const rightCommunication = parseCommunicationDate(right.communicationDate)?.getTime() || 0

    if (rightCommunication !== leftCommunication) {
      return rightCommunication - leftCommunication
    }

    return String(left.id || '').localeCompare(String(right.id || '')) ||
      String(left.serviceId || '').localeCompare(String(right.serviceId || ''))
  })

  const requestedLimit = Math.max(
    1,
    Math.min(Number.parseInt(String(limit), 10) || 20, 20)
  )
  const effectiveLimit = latest === true ? 1 : requestedLimit
  const items = matches.slice(0, effectiveLimit)

  return {
    type: 'renewals-communications',
    total: matches.length,
    shown: items.length,
    latest: latest === true,
    coverage: completeHistory ? 'history' : 'latest-per-service-type',
    query: {
      ...(normalizeCommunicationText(customerOrGroup) ? {customerOrGroup: normalizeCommunicationText(customerOrGroup)} : {}),
      ...(normalizeCommunicationText(service) ? {service: normalizeCommunicationText(service)} : {}),
      ...(typeof sentAutomatically === 'boolean' ? {sentAutomatically} : {}),
      limit: effectiveLimit,
    },
    items,
  }
}

function buildCommunicationScopeLabel(item = {}) {
  return [...new Map([item.customerName, item.groupName].filter(Boolean)
    .map(value => [normalizeComparable(value), value])).values()].join(' / ')
}

function buildSearchCommunicationsReply(data = {}) {
  const total = Number(data?.total || 0)
  const items = Array.isArray(data?.items) ? data.items : []

  if (!total || !items.length) {
    return 'Non ho trovato comunicazioni di rinnovo con i filtri richiesti.'
  }

  if (data.latest === true) {
    const item = items[0]
    const date = formatRecordedDateTime(item.communicationDate)
    const details = [
      item.serviceName ? `per ${item.serviceName}` : null,
      buildCommunicationScopeLabel(item) ? `cliente/gruppo ${buildCommunicationScopeLabel(item)}` : null,
      item.to ? `a ${item.to}` : null,
    ].filter(Boolean)
    return [
      `${date ? `L'ultima comunicazione di rinnovo è del ${date}` : 'La comunicazione di rinnovo trovata non ha una data disponibile'}${details.length ? `, ${details.join(', ')}` : ''}.`,
      item.typeLabel ? `Tipo: ${item.typeLabel}.` : null,
      !item.to ? 'Destinatario non disponibile nei dati.' : null,
      item.subject ? `Oggetto: «${item.subject}».` : 'Oggetto non disponibile nei dati.',
      typeof item.sentAutomatically === 'boolean' ? `Invio ${item.sentAutomatically ? 'automatico' : 'manuale'}.` : 'Modalità di invio non disponibile nei dati.',
    ].filter(Boolean).join(' ')
  }

  const lines = items.slice(0, 5).map(item => {
    const details = [
      formatRecordedDateTime(item.communicationDate),
      item.serviceName,
      buildCommunicationScopeLabel(item),
      item.to ? `a ${item.to}` : null,
      item.subject ? `oggetto "${item.subject}"` : null,
      item.typeLabel,
      typeof item.sentAutomatically === 'boolean' ? `invio ${item.sentAutomatically ? 'automatico' : 'manuale'}` : null,
    ].filter(Boolean)

    return `- ${details.join(' · ')}`
  })

  return [
    `Ho trovato ${total} comunicazioni di rinnovo. Ti mostro le ${items.length} più recenti; ecco un riepilogo delle prime ${Math.min(items.length, 5)}.`,
    data.coverage === 'latest-per-service-type' ? 'Il datasource contiene solo la comunicazione più recente per tipo e servizio, non lo storico completo.' : null,
    ...lines,
  ].filter(Boolean).join('\n')
}

async function executeSearchCommunications(args = {}) {
  const data = await searchRenewalCommunications({
    customerOrGroup: args.customerOrGroup,
    service: args.service,
    sentAutomatically: args.sentAutomatically,
    latest: args.latest === true,
    limit: args.limit || 20,
  })

  return {
    ok: true,
    moduleId: 'facile.renewals',
    reply: buildSearchCommunicationsReply(data),
    data,
    modelContent: {
      type: 'renewals-communication-search-result',
      total: data.total,
      shown: data.shown,
      latest: data.latest,
      coverage: data.coverage,
      query: data.query,
      items: (data.items || []).slice(0, 10),
    },
  }
}

function buildSearchServicesReply(data = {}, args = {}) {
  const total = Number(data?.totale || 0)
  const shown = Number(data?.shown || data?.items?.length || 0)
  const scope = String(args?.customerOrGroup || '').trim()
  const scopeLabel = scope ? ` di cliente/gruppo contenente "${scope}"` : ''

  if (!total) {
    return `Non ho trovato servizi${scopeLabel} con i filtri richiesti.`
  }

  if (shown < total) {
    return `Ho trovato ${total} servizi${scopeLabel}. Ti mostro i primi ${shown}.`
  }

  return `Ho trovato ${total} servizi${scopeLabel}.`
}

function compactItem(item = {}) {
  return {
    id: item.id || null,
    servizio: item.servizio || null,
    cliente: item.cliente || null,
    gruppo: item.gruppo || null,
    piano: item.piano || null,
    scadenza: item.scadenza || null,
    scadenzaFornitore: item.scadenzaFornitore || null,
    dontRenew: item.dontRenew === true,
    toRenew: item.toRenew === true,
    autoRenew: item.autoRenew === true,
    hasPlesk: item.hasPlesk === true,
    spazio: item.spazio
      ? {
          percent: Number(item.spazio.percent || 0),
          isFull: item.spazio.isFull === true,
          isLow: item.spazio.isLow === true,
        }
      : null,
    lastCommunicationDate: item.lastCommunicationDate || null,
  }
}

async function executeSearchServices(args = {}) {
  const [services, settings] = await Promise.all([getAllServices(), getSettings()])

  const data = buildStructuredServiceListPayload({
    services: Array.isArray(services) ? services : [],
    settings,
    customerOrGroup: args.customerOrGroup,
    serviceType: args.serviceType,
    plan: args.plan,
    supplier: args.supplier,
    expiresYear: args.expiresYear,
    expiresFrom: args.expiresFrom,
    expiresTo: args.expiresTo,
    supplierExpiresYear: args.supplierExpiresYear,
    supplierExpiresFrom: args.supplierExpiresFrom,
    supplierExpiresTo: args.supplierExpiresTo,
    flags: args.flags,
    spaceUsageGte: args.spaceUsageGte,
    dontRenewMode: args.dontRenewMode,
    limit: args.limit || 20,
    offset: args.offset || 0,
  })

  return {
    ok: true,
    moduleId: 'facile.renewals',
    reply: buildSearchServicesReply(data, args),
    data,
    modelContent: {
      type: 'renewals-service-search-result',
      total: data.totale,
      shown: data.shown,
      offset: data.query?.offset || 0,
      limit: data.query?.limit || 20,
      hasMore: data.hasMore === true,
      nextOffset: data.nextOffset,
      filters: data.query?.filters || [],
      items: (data.items || []).slice(0, 20).map(compactItem),
    },
  }
}

export const renewalsTools = [
  {
    name: RENEWALS_SEARCH_SERVICES_NAME,
    moduleId: 'facile.renewals',
    credential: 'crm',
    requiresPrincipal: true,
    capabilityId: 'facile.renewals.read',
    mode: 'read',
    risk: 'low',
    terminal: true,
    stateful: true,
    stateKeys: [
      'customerOrGroup',
      'serviceType',
      'plan',
      'supplier',
      'expiresYear',
      'flags',
      'dontRenewMode',
    ],
    definition: toolDefinition,
    execute: executeSearchServices,
  },
  {
    name: RENEWALS_SEARCH_COMMUNICATIONS_NAME,
    moduleId: 'facile.renewals',
    credential: 'crm',
    requiresPrincipal: true,
    capabilityId: 'facile.renewals.read',
    mode: 'read',
    risk: 'low',
    terminal: true,
    stateful: false,
    definition: communicationToolDefinition,
    execute: executeSearchCommunications,
  },
]
