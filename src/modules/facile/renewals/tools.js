import {getAllServices, getSettings} from './service.js'
import {buildStructuredServiceListPayload} from './serviceQueries.js'

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
      'Cerca comunicazioni o email di rinnovo già inviate. Restituisce data, destinatario, oggetto, servizio e cliente/gruppo.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerOrGroup: {type: 'string', description: 'Cliente o gruppo.'},
        service: {type: 'string', description: 'Nome servizio.'},
        sentAutomatically: {type: 'boolean', description: 'Invio automatico sì/no.'},
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
  if (value === null || value === undefined) return null

  if (Array.isArray(value)) {
    const items = value.map(normalizeCommunicationText).filter(Boolean)
    return items.length ? items.join(', ') : null
  }

  if (typeof value === 'object') {
    return normalizeCommunicationText(value.email || value.address || value.name || value.id)
  }

  const normalized = String(value).trim()
  return normalized || null
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
  const sentAutomatically =
    communication?.sentAutomatically ?? communication?.sent_automatically

  return {
    id: communication?.id || null,
    communicationDate:
      communication?.communicationDate ?? communication?.communication_date ?? null,
    dateCreated: communication?.dateCreated ?? communication?.date_created ?? null,
    type: normalizeCommunicationText(communication?.type),
    sentAutomatically:
      typeof sentAutomatically === 'boolean' ? sentAutomatically : null,
    to: normalizeCommunicationText(communication?.to),
    subject: normalizeCommunicationText(communication?.subject),
    description: normalizeCommunicationText(communication?.description),
    serviceId: service?.id || null,
    serviceName: service?.name || null,
    customerId: service?.customer?.id || null,
    customerName:
      service?.customer?.name || service?.customer?.businessName || null,
    groupId: service?.customer?.group?.id || null,
    groupName: service?.customer?.group?.name || null,
  }
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

  for (const item of Array.isArray(services) ? services : []) {
    if (!matchesCommunicationScope(item, {customerOrGroup, serviceName: service})) continue

    const communications =
      item?.renewalsCommunications || item?.renewals_communications || []

    for (const communication of Array.isArray(communications) ? communications : []) {
      const normalized = normalizeRenewalCommunication(item, communication)

      if (
        typeof sentAutomatically === 'boolean' &&
        normalized.sentAutomatically !== sentAutomatically
      ) {
        continue
      }

      matches.push(normalized)
    }
  }

  matches.sort((left, right) => {
    const leftCommunication = parseCommunicationDate(left.communicationDate)?.getTime() || 0
    const rightCommunication = parseCommunicationDate(right.communicationDate)?.getTime() || 0

    if (rightCommunication !== leftCommunication) {
      return rightCommunication - leftCommunication
    }

    const leftCreated = parseCommunicationDate(left.dateCreated)?.getTime() || 0
    const rightCreated = parseCommunicationDate(right.dateCreated)?.getTime() || 0

    return rightCreated - leftCreated
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
    query: {
      customerOrGroup: normalizeCommunicationText(customerOrGroup),
      service: normalizeCommunicationText(service),
      sentAutomatically:
        typeof sentAutomatically === 'boolean' ? sentAutomatically : null,
      limit: effectiveLimit,
    },
    items,
  }
}

function formatCommunicationDate(value) {
  if (!value) return null

  const text = String(value)

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-')
    return `${day}/${month}/${year}`
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return text

  return new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Rome',
  }).format(date)
}

function buildCommunicationScopeLabel(item = {}) {
  return [item.customerName, item.groupName].filter(Boolean).join(' / ')
}

function buildSearchCommunicationsReply(data = {}) {
  const total = Number(data?.total || 0)
  const items = Array.isArray(data?.items) ? data.items : []

  if (!total || !items.length) {
    return 'Non ho trovato comunicazioni di rinnovo con i filtri richiesti.'
  }

  if (data.latest === true) {
    const item = items[0]
    const details = [
      item.communicationDate ? `del ${formatCommunicationDate(item.communicationDate)}` : null,
      item.serviceName ? `per ${item.serviceName}` : null,
      buildCommunicationScopeLabel(item) || null,
      item.to ? `a ${item.to}` : null,
      item.subject ? `oggetto "${item.subject}"` : null,
      item.type ? `tipo ${item.type}` : null,
      typeof item.sentAutomatically === 'boolean'
        ? item.sentAutomatically
          ? 'invio automatico'
          : 'invio manuale'
        : null,
    ].filter(Boolean)

    return `L'ultima comunicazione di rinnovo trovata è ${details.join(' · ')}.`
  }

  const lines = items.slice(0, 5).map(item => {
    const details = [
      formatCommunicationDate(item.communicationDate),
      item.serviceName,
      buildCommunicationScopeLabel(item),
      item.to ? `a ${item.to}` : null,
      item.subject ? `oggetto "${item.subject}"` : null,
    ].filter(Boolean)

    return `- ${details.join(' · ')}`
  })

  return [
    `Ho trovato ${total} comunicazioni di rinnovo. Ti mostro le ${Math.min(items.length, 5)} più recenti.`,
    ...lines,
  ].join('\n')
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
