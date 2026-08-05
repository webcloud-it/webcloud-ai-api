import {createHash, randomUUID} from 'node:crypto'

import {callOllamaChat} from '../../../core/providers/ollamaProvider.js'
import {normalizeSearchText} from '../../../utils/text.js'
import {parseServiceListSelector, resolveServiceListReference} from './serviceListReferences.js'
import {pickPreviousServiceListState} from './serviceListState.js'

const DRAFT_CONTEXT_TTL_MS = 30 * 60 * 1000
const pendingClarifications = new Map()
const recentDrafts = new Map()

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i
const DOMAIN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/i

const DRAFT_VERB_PATTERN =
  /\b(?:bozza|prepara|preparami|predisponi|scrivi|scrivimi|genera|generami|crea|creami|componi|compila|redigi)\b/i
const COMMUNICATION_TERM_PATTERN = /\b(?:e-?mail|mail|comunicazione|messaggio)\b/i
const DRAFT_HINT_PATTERN = /\b(?:e-?mail|mail|comunicazione|messaggio|bozza|testo|lettera)\b/i
const READ_COMMUNICATION_PATTERN =
  /\b(?:ultima|ultime|quando|quale|quali|inviata|inviate|inviato|inviati|spedita|spedite|mandata|mandate|storico|elenco)\b/i
const SEND_VERB_PATTERN = /\b(?:invia|inviare|manda|mandare|spedisci|spedire)\b/i

const ORDINALS = new Map([
  ['primo', 1],
  ['prima', 1],
  ['secondo', 2],
  ['seconda', 2],
  ['terzo', 3],
  ['terza', 3],
  ['quarto', 4],
  ['quarta', 4],
  ['quinto', 5],
  ['quinta', 5],
])

function fingerprintToken(token = '') {
  return createHash('sha256')
    .update(String(token || ''))
    .digest('hex')
    .slice(0, 24)
}

function cleanupContexts(now = Date.now()) {
  for (const [key, value] of pendingClarifications.entries()) {
    if (!value || value.expiresAt <= now) pendingClarifications.delete(key)
  }

  for (const [key, value] of recentDrafts.entries()) {
    if (!value || value.expiresAt <= now) recentDrafts.delete(key)
  }
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizePurpose(message = '') {
  const text = normalizeSearchText(message)

  if (/\b(?:spazio|quota|disco|upgrade|aumento spazio|piano superiore)\b/i.test(text)) {
    return 'space-upgrade'
  }

  if (/\b(?:rinnovo|rinnovare|scadenza|scade|scadono|proroga)\b/i.test(text)) {
    return 'renewal'
  }

  return 'generic'
}

function cleanTarget(value = '') {
  return compactText(value)
    .replace(/[?.!,;:]+$/g, '')
    .replace(/^['"“”]+|['"“”]+$/g, '')
    .replace(/^(?:il|lo|la|i|gli|le|un|una)\s+/i, '')
    .replace(/^(?:servizio|dominio|cliente|gruppo)\s+/i, '')
    .trim()
}

function extractNamedTarget(message = '') {
  const text = String(message || '').trim()
  const quoted = text.match(/["“”']([^"“”']{2,})["“”']/)
  if (quoted?.[1]) return cleanTarget(quoted[1])

  const domain = text.match(DOMAIN_PATTERN)?.[0]
  if (domain) return domain

  const patterns = [
    /\b(?:per|riguardo|relativa?\s+a|relativa?\s+al|sul|su)\s+(.+)$/i,
    /\b(?:rinnovo|scadenza|upgrade)\s+(?:di|del|della|per)\s+(.+)$/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    const target = cleanTarget(match?.[1] || '')
    if (target && !/^(?:il\s+)?(?:rinnovo|servizio|cliente|gruppo)$/i.test(target)) {
      return target
    }
  }

  return null
}

export function parseCommunicationDraftRequest(message = '') {
  const text = compactText(message)
  if (!text || !COMMUNICATION_TERM_PATTERN.test(text)) return null
  if (READ_COMMUNICATION_PATTERN.test(text) && !DRAFT_VERB_PATTERN.test(text)) return null
  if (!DRAFT_VERB_PATTERN.test(text)) return null

  const selector = parseServiceListSelector(text)

  return {
    type: 'renewals-communication-draft-request',
    operation: 'draft',
    purpose: normalizePurpose(text),
    namedTarget: selector ? null : extractNamedTarget(text),
    selector,
    requestedSend: SEND_VERB_PATTERN.test(text),
    source: 'deterministic',
    sourceMessage: text,
  }
}

function extractJsonObject(value = '') {
  const text = String(value || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  try {
    return JSON.parse(text)
  } catch {}

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export async function planCommunicationDraftRequest({
  message = '',
  callLlm = callOllamaChat,
  allowSemantic = true,
} = {}) {
  const deterministic = parseCommunicationDraftRequest(message)
  if (deterministic) return deterministic

  const text = compactText(message)
  if (!allowSemantic || !DRAFT_HINT_PATTERN.test(text)) return null
  if (READ_COMMUNICATION_PATTERN.test(text)) return null
  if (SEND_VERB_PATTERN.test(text) && !/\b(?:bozza|testo|messaggio)\b/i.test(text)) return null

  try {
    const raw = await callLlm({
      timeoutMs: 5000,
      messages: [
        {
          role: 'system',
          content: [
            'Sei il planner delle bozze email del modulo rinnovi Webcloud.',
            'Non scrivere la mail e non inviare nulla.',
            'Riconosci soltanto richieste esplicite di preparare, scrivere o generare una bozza di comunicazione.',
            'Le richieste di leggere email già inviate o di inviare subito una email devono essere unknown.',
            'Restituisci esclusivamente JSON valido.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            request: text,
            outputSchema: {
              operation: 'draft | unknown',
              purpose: 'renewal | space-upgrade | generic',
              target: 'service/domain name or null',
              confidence: 'number 0..1',
            },
          }),
        },
      ],
    })

    const parsed = extractJsonObject(raw)
    if (parsed?.operation !== 'draft' || Number(parsed?.confidence || 0) < 0.75) {
      return null
    }

    return {
      type: 'renewals-communication-draft-request',
      operation: 'draft',
      purpose: ['renewal', 'space-upgrade', 'generic'].includes(parsed?.purpose)
        ? parsed.purpose
        : 'generic',
      namedTarget: cleanTarget(parsed?.target || '') || null,
      selector: null,
      requestedSend: false,
      source: 'semantic',
      sourceMessage: text,
    }
  } catch {
    return null
  }
}

function getDomainName(service = {}) {
  return service?.domains_id?.name || service?.domain?.name || null
}

function getCustomerPlanNames(service = {}) {
  return (service?.subscriptions || [])
    .filter(subscription => subscription?.isSupplier !== true)
    .map(subscription => subscription?.plan?.name)
    .filter(Boolean)
}

function serviceCandidate(service = {}, index = 0) {
  const plans = getCustomerPlanNames(service)
  const expiries = (service?.subscriptions || [])
    .filter(subscription => subscription?.isSupplier !== true && subscription?.endsOn)
    .map(subscription => subscription.endsOn)
    .sort()

  return {
    index,
    id: service?.id || null,
    name: service?.name || '—',
    domain: getDomainName(service),
    customerName: service?.customer?.name || '—',
    groupName: service?.customer?.group?.name || null,
    planNames: plans,
    nextExpiry: expiries[0] || null,
  }
}

function exactServiceMatches(services = [], target = '') {
  const needle = normalizeSearchText(target)
  if (!needle) return []

  const exact = services.filter(service => {
    return (
      normalizeSearchText(service?.name) === needle ||
      normalizeSearchText(getDomainName(service)) === needle
    )
  })

  if (exact.length) return exact

  return services.filter(service => {
    return (
      normalizeSearchText(service?.name).includes(needle) ||
      normalizeSearchText(getDomainName(service)).includes(needle)
    )
  })
}

function findServiceByItem(services = [], item = {}) {
  if (item?.id) {
    return services.find(service => String(service?.id) === String(item.id)) || null
  }

  const itemName = item?.servizio || item?.dominio || item?.name || null
  if (!itemName) return null

  const matches = exactServiceMatches(services, itemName)
  return matches.length === 1 ? matches[0] : null
}

function resolveSelector({request, services, settings, history, scope}) {
  if (!request?.selector) return null

  const previousState = pickPreviousServiceListState(
    history,
    scope,
    settings,
    request.sourceMessage || ''
  )
  const items = previousState?.data?.items || []
  const resolution = resolveServiceListReference({
    request: {
      type: 'service-list-reference',
      operation: 'detail',
      selector: request.selector,
    },
    items,
  })

  if (resolution.status !== 'resolved') {
    return {
      status: resolution.status || 'missing-list',
      candidates: [],
    }
  }

  const service = findServiceByItem(services, resolution.item)
  return service
    ? {status: 'resolved', service}
    : {status: 'not-found', candidates: []}
}

export function resolveCommunicationDraftTarget({
  request,
  services = [],
  settings = {},
  history = [],
  scope = {},
} = {}) {
  if (request?.selector) {
    return resolveSelector({request, services, settings, history, scope})
  }

  if (scope?.serviceId) {
    const scoped = services.find(service => String(service?.id) === String(scope.serviceId))
    if (scoped) return {status: 'resolved', service: scoped}
  }

  if (!request?.namedTarget) {
    return {status: 'missing-target', candidates: []}
  }

  const matches = exactServiceMatches(services, request.namedTarget)
  if (matches.length === 1) return {status: 'resolved', service: matches[0]}
  if (!matches.length) return {status: 'not-found', candidates: []}

  return {
    status: 'ambiguous',
    candidates: matches.map(serviceCandidate),
  }
}

function selectCandidate(message = '', candidates = []) {
  const text = normalizeSearchText(message)
  if (!text) return null

  const numeric = text.match(/\b(?:opzione|numero|n\.?|il|la)?\s*(\d{1,2})\b/i)?.[1]
  if (numeric) return candidates[Number(numeric) - 1] || null

  for (const [word, position] of ORDINALS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) {
      return candidates[position - 1] || null
    }
  }

  const matches = candidates.filter(candidate => {
    return [
      candidate.name,
      candidate.domain,
      candidate.customerName,
      candidate.groupName,
      ...(candidate.planNames || []),
    ].some(value => normalizeSearchText(value).includes(text))
  })

  return matches.length === 1 ? matches[0] : null
}

function rememberClarification({actorToken, request, candidates}) {
  cleanupContexts()
  pendingClarifications.set(fingerprintToken(actorToken), {
    request,
    candidates,
    expiresAt: Date.now() + DRAFT_CONTEXT_TTL_MS,
  })
}

export function hasPendingCommunicationDraftClarification({actorToken = ''} = {}) {
  cleanupContexts()
  return pendingClarifications.has(fingerprintToken(actorToken))
}

export function getRecentCommunicationDraft({actorToken = ''} = {}) {
  cleanupContexts()
  return recentDrafts.get(fingerprintToken(actorToken))?.draft || null
}

function buildClarificationReply(resolution = {}) {
  if (resolution.status === 'missing-target') {
    return 'Indica per quale servizio o dominio vuoi preparare la bozza email.'
  }

  if (resolution.status === 'not-found') {
    return 'Non ho trovato un servizio corrispondente. Indica il nome esatto del servizio o del dominio.'
  }

  if (resolution.status === 'missing-list' || resolution.status === 'empty-list') {
    return 'Non ho una lista precedente da cui selezionare il servizio. Indica il nome del servizio o del dominio.'
  }

  if (resolution.status === 'out-of-range') {
    return 'La posizione indicata non è presente nella lista precedente.'
  }

  if (resolution.status === 'ambiguous') {
    const rows = (resolution.candidates || []).map((candidate, index) => {
      const details = [candidate.customerName]
      if (candidate.planNames?.length) details.push(`piano ${candidate.planNames.join(', ')}`)
      if (candidate.nextExpiry) details.push(`scadenza ${formatDate(candidate.nextExpiry)}`)
      return `${index + 1}. ${candidate.name} | ${details.join(' | ')}`
    })

    return `Ho trovato più servizi compatibili. Indica quello corretto:\n${rows.join('\n')}`
  }

  return 'Non riesco a identificare il servizio. Indica il nome esatto.'
}

function formatDate(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('it-IT').format(date)
}

function extractRecipients(service = {}) {
  const recipients = []

  for (const contact of service?.customer?.contacts || []) {
    for (const item of contact?.items || []) {
      const email = String(item?.item || '').trim().toLowerCase()
      if (!EMAIL_PATTERN.test(email)) continue
      if (recipients.some(recipient => recipient.email === email)) continue

      recipients.push({
        email,
        contactId: contact?.id || null,
        contactName: contact?.name || null,
        contactRole: contact?.role || null,
        contactItemId: item?.id || null,
      })
    }
  }

  return recipients
}

function getCustomerSubscriptions(service = {}) {
  return (service?.subscriptions || [])
    .filter(subscription => subscription?.isSupplier !== true)
    .map(subscription => ({
      id: subscription?.id || null,
      planName: subscription?.plan?.name || null,
      description: subscription?.plan?.description || null,
      endsOn: subscription?.endsOn || null,
      priceFinal:
        subscription?.plan?.priceFinal === null || subscription?.plan?.priceFinal === undefined
          ? null
          : Number(subscription.plan.priceFinal),
      addons: (subscription?.addons || []).map(addon => addon?.name).filter(Boolean),
    }))
    .sort((first, second) => {
      const firstTime = first.endsOn ? new Date(first.endsOn).getTime() : Number.MAX_SAFE_INTEGER
      const secondTime = second.endsOn ? new Date(second.endsOn).getTime() : Number.MAX_SAFE_INTEGER
      return firstTime - secondTime
    })
}

function buildDraftFacts(service = {}, purpose = 'generic') {
  const subscriptions = getCustomerSubscriptions(service)
  const space = service?.pleskDomain?.statsDiskUsage || null
  const quota = Number(space?.quota || 0)
  const used = Number(space?.totalSize || 0)

  return {
    purpose,
    service: {
      id: service?.id || null,
      name: service?.name || '—',
      domain: getDomainName(service),
    },
    customer: {
      id: service?.customer?.id || null,
      name: service?.customer?.name || '—',
      groupName: service?.customer?.group?.name || null,
    },
    subscriptions,
    nextExpiry: subscriptions.find(subscription => subscription.endsOn)?.endsOn || null,
    space:
      quota > 0
        ? {
            used,
            quota,
            percent: (used / quota) * 100,
          }
        : null,
  }
}

function buildFallbackContent(facts = {}) {
  const customerName = facts?.customer?.name || 'Cliente'
  const serviceName = facts?.service?.name || 'servizio'
  const subscription = facts?.subscriptions?.[0] || null

  if (facts.purpose === 'renewal') {
    const expiry = subscription?.endsOn ? formatDate(subscription.endsOn) : null
    const plan = subscription?.planName ? ` (${subscription.planName})` : ''

    return {
      subject: `Rinnovo del servizio ${serviceName}`,
      bodyText: [
        `Gentile ${customerName},`,
        '',
        `la contattiamo in merito al rinnovo del servizio ${serviceName}${plan}${expiry ? `, con scadenza il ${expiry}` : ''}.`,
        'Restiamo a disposizione per confermare il rinnovo o per eventuali chiarimenti.',
        '',
        'Cordiali saluti,',
        'Webcloud',
      ].join('\n'),
    }
  }

  if (facts.purpose === 'space-upgrade') {
    const percent = facts?.space?.percent
    return {
      subject: `Spazio disponibile per il servizio ${serviceName}`,
      bodyText: [
        `Gentile ${customerName},`,
        '',
        `la contattiamo in merito allo spazio disponibile per il servizio ${serviceName}${Number.isFinite(percent) ? `, attualmente utilizzato al ${percent.toFixed(1)}%` : ''}.`,
        'Possiamo valutare insieme l’adeguamento del piano o dello spazio disponibile.',
        '',
        'Cordiali saluti,',
        'Webcloud',
      ].join('\n'),
    }
  }

  return {
    subject: `Comunicazione relativa al servizio ${serviceName}`,
    bodyText: [
      `Gentile ${customerName},`,
      '',
      `la contattiamo in merito al servizio ${serviceName}.`,
      'Restiamo a disposizione per eventuali chiarimenti.',
      '',
      'Cordiali saluti,',
      'Webcloud',
    ].join('\n'),
  }
}

async function generateDraftContent({facts, request, generateFn = callOllamaChat}) {
  const fallback = buildFallbackContent(facts)

  try {
    const raw = await generateFn({
      timeoutMs: 8000,
      messages: [
        {
          role: 'system',
          content: [
            'Sei il redattore delle bozze email del pannello rinnovi Webcloud.',
            'Scrivi in italiano, con tono professionale, chiaro e conciso.',
            'Usa esclusivamente i fatti presenti nel JSON.',
            'Non inventare prezzi, date, condizioni contrattuali, sconti, destinatari o operazioni già eseguite.',
            'Non inserire link, firme personali o promesse non presenti nei dati.',
            'La mail è soltanto una bozza e non viene inviata.',
            'Restituisci esclusivamente JSON valido con subject e bodyText.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            request: request?.sourceMessage || '',
            purpose: request?.purpose || 'generic',
            facts,
            outputSchema: {
              subject: 'string, massimo 140 caratteri',
              bodyText: 'string in testo semplice',
            },
          }),
        },
      ],
    })

    const parsed = extractJsonObject(raw)
    const subject = compactText(parsed?.subject || '').slice(0, 140)
    const bodyText = String(parsed?.bodyText || '').trim()

    if (!subject || !bodyText || bodyText.length > 6000) return fallback

    return {subject, bodyText}
  } catch {
    return fallback
  }
}

function rememberDraft(actorToken = '', draft = null) {
  if (!draft) return
  cleanupContexts()
  recentDrafts.set(fingerprintToken(actorToken), {
    draft,
    expiresAt: Date.now() + DRAFT_CONTEXT_TTL_MS,
  })
}

function buildDraftReply(draft = {}) {
  const recipients = draft.recipients || []
  const recipientLines = recipients.length
    ? recipients.map(recipient => {
        const contact = [recipient.contactName, recipient.contactRole]
          .filter(Boolean)
          .join(' · ')
        return `- ${recipient.email}${contact ? ` (${contact})` : ''}`
      })
    : ['- nessun indirizzo email disponibile nei contatti del cliente']

  const warnings = []
  if (!recipients.length) {
    warnings.push('La bozza non ha destinatari proposti: dovranno essere indicati prima di un eventuale invio.')
  }
  if (draft.requestedSend) {
    warnings.push('La richiesta conteneva anche un invio, ma in questo passaggio non è stata spedita alcuna email.')
  }

  return [
    `Bozza email per il servizio "${draft.target.label}". Nessun invio è stato eseguito.`,
    '',
    'Destinatari proposti:',
    ...recipientLines,
    '',
    `Oggetto: ${draft.subject}`,
    '',
    'Testo:',
    draft.bodyText,
    ...(warnings.length ? ['', ...warnings] : []),
  ].join('\n')
}

export async function buildCommunicationDraftPreview({
  request,
  services = [],
  settings = {},
  history = [],
  scope = {},
  actorToken = '',
  generateFn = callOllamaChat,
} = {}) {
  cleanupContexts()

  const resolution = resolveCommunicationDraftTarget({
    request,
    services,
    settings,
    history,
    scope,
  })

  if (resolution.status !== 'resolved') {
    if (resolution.status === 'ambiguous') {
      rememberClarification({
        actorToken,
        request,
        candidates: resolution.candidates,
      })
    }

    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildClarificationReply(resolution),
      data: {
        type: 'clarification',
        reason: `communication-draft-target-${resolution.status}`,
        candidates: resolution.candidates || [],
      },
      meta: {
        moduleId: 'facile.renewals',
        intent: 'clarification',
        tool: 'renewals.communication-draft',
      },
    }
  }

  const service = resolution.service
  const facts = buildDraftFacts(service, request?.purpose || 'generic')
  const recipients = extractRecipients(service)
  const content = await generateDraftContent({facts, request, generateFn})
  const draft = {
    draftId: randomUUID(),
    status: 'draft',
    previewOnly: true,
    sendAllowed: false,
    requestedSend: request?.requestedSend === true,
    purpose: request?.purpose || 'generic',
    target: {
      type: 'service',
      id: String(service.id),
      label: service?.name || getDomainName(service) || String(service.id),
      domain: getDomainName(service),
      customerId: service?.customer?.id || null,
      customerName: service?.customer?.name || null,
    },
    recipients,
    subject: content.subject,
    bodyText: content.bodyText,
    facts,
    warnings: [
      ...(recipients.length ? [] : ['recipient-missing']),
      ...(request?.requestedSend ? ['send-not-executed'] : []),
    ],
    createdAt: new Date().toISOString(),
  }

  pendingClarifications.delete(fingerprintToken(actorToken))
  rememberDraft(actorToken, draft)

  return {
    ok: true,
    intent: 'communication-draft',
    source: request?.source === 'semantic' ? 'tool-semantic' : 'tool-fast',
    reply: buildDraftReply(draft),
    data: {
      type: 'communication-draft',
      draft,
    },
    meta: {
      moduleId: 'facile.renewals',
      intent: 'communication-draft',
      tool: 'renewals.communication-draft',
      previewOnly: true,
      sendExecuted: false,
      plannerSource: request?.source || 'deterministic',
    },
  }
}

export async function handlePendingCommunicationDraftClarification({
  message = '',
  services = [],
  settings = {},
  history = [],
  scope = {},
  actorToken = '',
  generateFn = callOllamaChat,
} = {}) {
  cleanupContexts()
  const key = fingerprintToken(actorToken)
  const pending = pendingClarifications.get(key)
  if (!pending) return null

  if (/^(?:annulla|cancella|lascia stare|lascia perdere|stop|no)$/i.test(compactText(message))) {
    pendingClarifications.delete(key)
    return {
      ok: true,
      intent: 'communication-draft-cancelled',
      source: 'tool-fast',
      reply: 'Preparazione della bozza annullata. Nessuna email è stata inviata.',
      data: {
        type: 'communication-draft-cancelled',
        status: 'cancelled',
      },
      meta: {
        moduleId: 'facile.renewals',
        intent: 'communication-draft-cancelled',
        tool: 'renewals.communication-draft',
      },
    }
  }

  const selected = selectCandidate(message, pending.candidates || [])
  if (!selected) {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: buildClarificationReply({
        status: 'ambiguous',
        candidates: pending.candidates || [],
      }),
      data: {
        type: 'clarification',
        reason: 'communication-draft-target-selection-invalid',
        candidates: pending.candidates || [],
      },
      meta: {
        moduleId: 'facile.renewals',
        intent: 'clarification',
        tool: 'renewals.communication-draft',
      },
    }
  }

  const service = services.find(item => String(item?.id) === String(selected.id))
  if (!service) {
    pendingClarifications.delete(key)
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: 'Il servizio selezionato non è più disponibile. Ripeti la richiesta indicando il servizio.',
      data: {
        type: 'clarification',
        reason: 'communication-draft-target-stale',
      },
      meta: {
        moduleId: 'facile.renewals',
        intent: 'clarification',
        tool: 'renewals.communication-draft',
      },
    }
  }

  pendingClarifications.delete(key)

  return buildCommunicationDraftPreview({
    request: {
      ...pending.request,
      namedTarget: service?.name || getDomainName(service),
      selector: null,
    },
    services,
    settings,
    history,
    scope: {
      ...scope,
      serviceId: service.id,
    },
    actorToken,
    generateFn,
  })
}
