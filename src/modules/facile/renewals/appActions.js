import {createHash} from 'node:crypto'

import {callOllamaChat} from '../../../core/providers/ollamaProvider.js'
import {normalizeSearchText} from '../../../utils/text.js'
import {parseServiceListSelector, resolveServiceListReference} from './serviceListReferences.js'
import {pickPreviousServiceListState} from './serviceListState.js'
import {
  describeEmailGenerationConfiguration,
  hasEmailGenerationConfiguration,
  isEmailGenerationConfigurationRequest,
  normalizeEmailGenerationConfiguration,
  parseEmailGenerationConfiguration,
  stripEmailGenerationConfigurationTail,
} from './emailGenerationConfig.js'

export const OPEN_EMAIL_GENERATION_ACTION_ID = 'facile.renewals.open-email-generation'

const CONTEXT_TTL_MS = 30 * 60 * 1000
const pendingClarifications = new Map()

const EMAIL_TERM_PATTERN = /\b(?:e-?mail|mail|comunicazione)\b/i
const EMAIL_UI_VERB_PATTERN =
  /\b(?:apri|aprimi|vai|portami|mostra|mostrami|prepara|preparami|predisponi|genera|generami|compila|imposta)\b/i
const DRAFT_ONLY_PATTERN = /\b(?:bozza|testo|scrivi|scrivimi|redigi|componi)\b/i
const READ_ONLY_PATTERN =
  /\b(?:ultima|ultime|storico|elenco|quando|quale|quali)\b.{0,30}\b(?:e-?mail|mail|comunicazioni?)\b/i
const NEW_REQUEST_PATTERN =
  /\b(?:dettagli|parlami|raccontami|mostra|mostrami|elenca|elencami|lista|servizi|piani|fornitori|rinnova|imposta|modifica|segna|controlla|verifica)\b/i
const DOMAIN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/i

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
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function cleanTarget(value = '') {
  return compactText(value)
    .replace(/[?.!,;:]+$/g, '')
    .replace(/^['"“”]+|['"“”]+$/g, '')
    .replace(/^(?:il|lo|la|i|gli|le|un|una)\s+/i, '')
    .replace(/^(?:servizio|dominio|cliente|azienda|gruppo|gruppo aziendale)\s+/i, '')
    .trim()
}

function normalizePurpose(message = '') {
  const text = normalizeSearchText(message)

  if (/\b(?:spazio|quota|disco|upgrade|aumento spazio|piano superiore)\b/i.test(text)) {
    return 'space-upgrade'
  }

  if (/\b(?:rinnovo|rinnovare|scadenz[ae]|scade|scadono|proroga)\b/i.test(text)) {
    return 'renewal'
  }

  return 'generic'
}

function detectScopeHint(message = '') {
  const text = normalizeSearchText(message)

  const explicit = [
    ['group', /\b(?:per|su|sul)?\s*(?:il|lo|la|un|una)?\s*(?:gruppo|gruppo aziendale)\b/i],
    ['customer', /\b(?:per|su|sul)?\s*(?:il|lo|la|un|una)?\s*(?:cliente|azienda)\b/i],
    ['service', /\b(?:per|su|sul)?\s*(?:il|lo|la|un|una)?\s*(?:servizio|dominio|sito)\b/i],
  ]
    .map(([kind, pattern]) => {
      const match = pattern.exec(text)
      return match ? {kind, index: match.index} : null
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)

  if (explicit[0]) return explicit[0].kind
  if (DOMAIN_PATTERN.test(text)) return 'service'

  return null
}

function isServiceListReferenceMessage(message = '') {
  const text = normalizeSearchText(message)

  return (
    /\b(?:primo|prima|secondo|seconda|terzo|terza|quarto|quarta|quinto|quinta|ultimo|ultima|penultimo|penultima)\b/i.test(text) ||
    /\b(?:numero|opzione|riga)\s*\d{1,2}\b/i.test(text) ||
    /\b(?:il|la)\s+\d{1,2}\b/i.test(text)
  )
}

function isConfigurationPhrase(value = '') {
  const text = normalizeSearchText(value)

  return (
    /^(?:i\s+|gli\s+|le\s+)?servizi?\s+con\s+piano\b/i.test(text) ||
    /^(?:i\s+|gli\s+|le\s+)?dati\s+(?:di|dell['’]?)\s*occupazione\b/i.test(text) ||
    /^(?:piano\s+)?domreg\b/i.test(text)
  )
}

function extractNamedTarget(message = '') {
  const original = compactText(message)

  if (!EMAIL_TERM_PATTERN.test(original) && isEmailGenerationConfigurationRequest(original)) {
    return null
  }

  const text = stripEmailGenerationConfigurationTail(original)

  const quotedTarget = text.match(
    /\b(?:per|su|sul|cliente|azienda|gruppo|gruppo aziendale|servizio|dominio)\s+["“”']([^"“”']{2,})["“”']/i
  )
  if (quotedTarget?.[1]) return cleanTarget(quotedTarget[1])

  const domain = text.match(DOMAIN_PATTERN)?.[0]
  if (domain) return domain

  const explicitScoped = text.match(
    /\b(?:per|su|sul)?\s*(?:il|lo|la|un|una)?\s*(?:cliente|azienda|gruppo(?:\s+aziendale)?|servizio|dominio)\s+(.+)$/i
  )
  const scopedTarget = cleanTarget(explicitScoped?.[1] || '')
  if (scopedTarget && !isConfigurationPhrase(scopedTarget)) return scopedTarget

  const generic = text.match(
    /\b(?:per|su|sul|riguardo|relativa?\s+a|relativa?\s+al)\s+(.+)$/i
  )
  const genericTarget = cleanTarget(generic?.[1] || '')
  if (genericTarget && !isConfigurationPhrase(genericTarget)) return genericTarget

  return null
}

export function parseOpenEmailGenerationAction(message = '', {now = new Date()} = {}) {
  const text = compactText(message)
  if (!text || READ_ONLY_PATTERN.test(text) || DRAFT_ONLY_PATTERN.test(text)) return null

  const parsedConfiguration = parseEmailGenerationConfiguration(text, {now})
  const hasConfiguration = hasEmailGenerationConfiguration(parsedConfiguration.configuration)
  const hasEmailUiIntent = EMAIL_TERM_PATTERN.test(text) && EMAIL_UI_VERB_PATTERN.test(text)
  const hasConfigurationIntent =
    hasConfiguration && isEmailGenerationConfigurationRequest(text)

  if (!hasEmailUiIntent && !hasConfigurationIntent) return null

  const selector = isServiceListReferenceMessage(text)
    ? parseServiceListSelector(text)
    : null

  return {
    type: 'renewals-open-email-generation-request',
    operation: 'open-email-generation',
    purpose: normalizePurpose(text),
    scopeHint: detectScopeHint(text),
    namedTarget: selector ? null : extractNamedTarget(text),
    selector,
    configuration: parsedConfiguration.configuration,
    configurationErrors: parsedConfiguration.errors,
    configurationWarnings: parsedConfiguration.warnings,
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

export async function planOpenEmailGenerationAction({
  message = '',
  callLlm = callOllamaChat,
  allowSemantic = true,
} = {}) {
  const deterministic = parseOpenEmailGenerationAction(message)
  if (deterministic) return deterministic

  const text = compactText(message)
  if (!allowSemantic) return null
  if (READ_ONLY_PATTERN.test(text) || DRAFT_ONLY_PATTERN.test(text)) return null
  if (!EMAIL_TERM_PATTERN.test(text) && !isEmailGenerationConfigurationRequest(text)) return null

  try {
    const raw = await callLlm({
      timeoutMs: 5000,
      messages: [
        {
          role: 'system',
          content: [
            'Sei il planner delle action UI del pannello rinnovi Webcloud.',
            'Riconosci soltanto richieste che vogliono aprire o preparare la schermata Email dell’applicazione.',
            'Non generare il testo della mail, non inviare nulla e non accedere ai dati.',
            'Le richieste di scrivere una bozza o leggere lo storico devono essere unknown.',
            'Restituisci esclusivamente JSON valido.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            request: text,
            outputSchema: {
              operation: 'open-email-generation | unknown',
              purpose: 'renewal | space-upgrade | generic',
              scopeHint: 'group | customer | service | null',
              target: 'name or null',
              configuration: {
                showAllServices: 'boolean or null',
                includeDomainRegistrationUsage: 'boolean or null',
                showPleskAddons: 'boolean or null',
                showAutoRenewServices: 'boolean or null',
                hideUsageDetails: 'boolean or null',
                hideDiscountDetails: 'boolean or null',
                limitFullSpaceToPeriod: 'boolean or null',
                includeFutureLowSpace: 'boolean or null',
                showRecentlyContacted: 'boolean or null',
                hideRecentlyCommunicatedUpgrades: 'boolean or null',
                testMode: 'boolean or null',
                testEmail: 'string or null',
                analysisPeriodDays: 'integer or null',
                analysisEndDate: 'YYYY-MM-DD or null',
                subject: 'string or null',
                recipientEmail: 'string or null',
              },
              confidence: 'number 0..1',
            },
          }),
        },
      ],
    })

    const parsed = extractJsonObject(raw)
    if (
      parsed?.operation !== 'open-email-generation' ||
      Number(parsed?.confidence || 0) < 0.78
    ) {
      return null
    }

    const normalizedConfiguration = normalizeEmailGenerationConfiguration(
      parsed?.configuration || {},
      {now: new Date()}
    )

    return {
      type: 'renewals-open-email-generation-request',
      operation: 'open-email-generation',
      purpose: ['renewal', 'space-upgrade', 'generic'].includes(parsed?.purpose)
        ? parsed.purpose
        : 'generic',
      scopeHint: ['group', 'customer', 'service'].includes(parsed?.scopeHint)
        ? parsed.scopeHint
        : null,
      namedTarget: cleanTarget(parsed?.target || '') || null,
      selector: null,
      configuration: normalizedConfiguration.configuration,
      configurationErrors: normalizedConfiguration.errors,
      configurationWarnings: normalizedConfiguration.warnings,
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

function serviceMatches(service = {}, target = '') {
  const needle = normalizeSearchText(target)
  return (
    normalizeSearchText(service?.name) === needle ||
    normalizeSearchText(getDomainName(service)) === needle
  )
}

function partialServiceMatches(service = {}, target = '') {
  const needle = normalizeSearchText(target)
  return (
    normalizeSearchText(service?.name).includes(needle) ||
    normalizeSearchText(getDomainName(service)).includes(needle)
  )
}

function uniqueGroups(services = []) {
  const map = new Map()

  for (const service of services) {
    const group = service?.customer?.group
    if (!group?.id || !group?.name) continue
    map.set(String(group.id), {id: String(group.id), label: group.name})
  }

  return [...map.values()]
}

function uniqueCustomers(services = []) {
  const map = new Map()

  for (const service of services) {
    const customer = service?.customer
    if (!customer?.id || !customer?.name) continue
    map.set(String(customer.id), {
      id: String(customer.id),
      label: customer.name,
      groupId: customer?.group?.id ? String(customer.group.id) : null,
      groupLabel: customer?.group?.name || null,
    })
  }

  return [...map.values()]
}

function exactNamedMatches(items = [], target = '') {
  const needle = normalizeSearchText(target)
  const exact = items.filter(item => normalizeSearchText(item?.label) === needle)
  if (exact.length) return exact
  return items.filter(item => normalizeSearchText(item?.label).includes(needle))
}

function buildScopeFromService(service = {}) {
  const customer = service?.customer
  if (!customer?.id || !customer?.name) return null

  return {
    type: 'customer',
    id: String(customer.id),
    label: customer.name,
  }
}

function buildCandidateFromService(service = {}) {
  return {
    kind: 'service',
    id: String(service?.id || ''),
    label: service?.name || getDomainName(service) || String(service?.id || ''),
    detail: [service?.customer?.name, service?.customer?.group?.name]
      .filter(Boolean)
      .join(' · '),
    scope: buildScopeFromService(service),
  }
}

function buildCandidate(kind, item = {}) {
  return {
    kind,
    id: String(item.id),
    label: item.label,
    detail:
      kind === 'customer' && item.groupLabel ? `gruppo ${item.groupLabel}` : null,
    scope: {
      type: kind,
      id: String(item.id),
      label: item.label,
    },
  }
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
    return {status: resolution.status || 'missing-list', candidates: []}
  }

  const id = resolution.item?.id
  const name = resolution.item?.servizio || resolution.item?.dominio || null
  const service = id
    ? services.find(item => String(item?.id) === String(id))
    : services.find(item => serviceMatches(item, name))

  return service
    ? {status: 'resolved', scope: buildScopeFromService(service), source: buildCandidateFromService(service)}
    : {status: 'not-found', candidates: []}
}

export function resolveOpenEmailGenerationTarget({
  request,
  services = [],
  settings = {},
  history = [],
  scope = {},
} = {}) {
  if (request?.selector) {
    return resolveSelector({request, services, settings, history, scope})
  }

  if (!request?.namedTarget) {
    if (scope?.customerId) {
      const customer = uniqueCustomers(services).find(
        item => String(item.id) === String(scope.customerId)
      )
      if (customer) {
        return {
          status: 'resolved',
          scope: {type: 'customer', id: customer.id, label: customer.label},
          source: buildCandidate('customer', customer),
        }
      }
    }

    if (scope?.groupId) {
      const group = uniqueGroups(services).find(item => String(item.id) === String(scope.groupId))
      if (group) {
        return {
          status: 'resolved',
          scope: {type: 'group', id: group.id, label: group.label},
          source: buildCandidate('group', group),
        }
      }
    }

    if (scope?.serviceId) {
      const service = services.find(item => String(item?.id) === String(scope.serviceId))
      const resolvedScope = buildScopeFromService(service)
      if (service && resolvedScope) {
        return {
          status: 'resolved',
          scope: resolvedScope,
          source: buildCandidateFromService(service),
        }
      }
    }

    return {status: 'missing-target', candidates: []}
  }

  const target = request.namedTarget
  const groups = exactNamedMatches(uniqueGroups(services), target)
  const customers = exactNamedMatches(uniqueCustomers(services), target)
  let serviceMatchesList = services.filter(service => serviceMatches(service, target))
  if (!serviceMatchesList.length) {
    serviceMatchesList = services.filter(service => partialServiceMatches(service, target))
  }

  if (request.scopeHint === 'group') {
    if (groups.length === 1) {
      return {
        status: 'resolved',
        scope: {type: 'group', id: groups[0].id, label: groups[0].label},
        source: buildCandidate('group', groups[0]),
      }
    }
    return groups.length > 1
      ? {status: 'ambiguous', candidates: groups.map(item => buildCandidate('group', item))}
      : {status: 'not-found', candidates: []}
  }

  if (request.scopeHint === 'customer') {
    if (customers.length === 1) {
      return {
        status: 'resolved',
        scope: {type: 'customer', id: customers[0].id, label: customers[0].label},
        source: buildCandidate('customer', customers[0]),
      }
    }
    return customers.length > 1
      ? {status: 'ambiguous', candidates: customers.map(item => buildCandidate('customer', item))}
      : {status: 'not-found', candidates: []}
  }

  if (request.scopeHint === 'service' || DOMAIN_PATTERN.test(target)) {
    if (serviceMatchesList.length === 1) {
      return {
        status: 'resolved',
        scope: buildScopeFromService(serviceMatchesList[0]),
        source: buildCandidateFromService(serviceMatchesList[0]),
      }
    }
    return serviceMatchesList.length > 1
      ? {status: 'ambiguous', candidates: serviceMatchesList.map(buildCandidateFromService)}
      : {status: 'not-found', candidates: []}
  }

  const candidates = [
    ...groups.map(item => buildCandidate('group', item)),
    ...customers.map(item => buildCandidate('customer', item)),
    ...serviceMatchesList.map(buildCandidateFromService),
  ]

  const scopes = new Map()
  for (const candidate of candidates) {
    if (!candidate?.scope?.id) continue
    scopes.set(`${candidate.scope.type}:${candidate.scope.id}`, candidate)
  }

  const unique = [...scopes.values()]
  if (unique.length === 1) {
    return {
      status: 'resolved',
      scope: unique[0].scope,
      source: unique[0],
    }
  }

  return unique.length
    ? {status: 'ambiguous', candidates: unique}
    : {status: 'not-found', candidates: []}
}

function buildClarificationReply(resolution = {}) {
  if (resolution.status === 'missing-target') {
    return 'Indica il cliente, il gruppo o il servizio per cui vuoi aprire la generazione email.'
  }

  if (resolution.status === 'not-found') {
    return 'Non ho trovato il cliente, il gruppo o il servizio indicato. Specifica il nome esatto.'
  }

  if (resolution.status === 'missing-list' || resolution.status === 'empty-list') {
    return 'Non ho una lista precedente da cui selezionare il servizio. Indica il nome del servizio.'
  }

  if (resolution.status === 'out-of-range') {
    return 'La posizione indicata non è presente nella lista precedente.'
  }

  const rows = (resolution.candidates || []).map((candidate, index) => {
    const kindLabel =
      candidate.kind === 'group'
        ? 'gruppo'
        : candidate.kind === 'customer'
          ? 'cliente'
          : 'servizio'
    return `${index + 1}. ${kindLabel} “${candidate.label}”${candidate.detail ? ` | ${candidate.detail}` : ''}`
  })

  return [
    'Ho trovato più destinazioni compatibili. Indica quella corretta:',
    ...rows,
    '',
    'Puoi rispondere con il numero oppure con “cliente”, “gruppo” o “servizio”.',
  ].join('\n')
}

function rememberClarification({actorToken, request, candidates}) {
  cleanupContexts()
  pendingClarifications.set(fingerprintToken(actorToken), {
    request,
    candidates,
    expiresAt: Date.now() + CONTEXT_TTL_MS,
  })
}

export function hasPendingOpenEmailGenerationClarification({actorToken = ''} = {}) {
  cleanupContexts()
  return pendingClarifications.has(fingerprintToken(actorToken))
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

  const kind = /\bgruppo\b/i.test(text)
    ? 'group'
    : /\b(?:cliente|azienda)\b/i.test(text)
      ? 'customer'
      : /\b(?:servizio|dominio)\b/i.test(text)
        ? 'service'
        : null

  const byKind = kind ? candidates.filter(candidate => candidate.kind === kind) : candidates
  if (byKind.length === 1) return byKind[0]

  const named = byKind.filter(candidate =>
    normalizeSearchText(candidate.label).includes(text.replace(/\b(?:cliente|azienda|gruppo|servizio|dominio)\b/g, '').trim())
  )

  return named.length === 1 ? named[0] : null
}

function buildAppActionResult({request, scope = null, source = null}) {
  const configuration = request?.configuration || {}
  const configurationRows = describeEmailGenerationConfiguration(configuration)
  const replyRows = []

  if (scope) {
    const kindLabel = scope.type === 'group' ? 'gruppo' : 'cliente'
    replyRows.push(`Apro la sezione Email e seleziono il ${kindLabel} “${scope.label}”.`)
  } else {
    replyRows.push('Apro la sezione Email mantenendo la destinazione attualmente selezionata.')
  }

  if (configurationRows.length) {
    replyRows.push('Applico queste impostazioni:')
    replyRows.push(...configurationRows.map(row => `- ${row}`))
  } else {
    replyRows.push('La tabella e l’anteprima verranno generate dall’app con i dati correnti.')
  }

  for (const warning of request?.configurationWarnings || []) {
    replyRows.push(`Attenzione: ${warning}`)
  }

  return {
    ok: true,
    intent: 'app-action',
    source: request?.source === 'semantic' ? 'tool-semantic' : 'tool-fast',
    reply: replyRows.join('\n'),
    data: {
      type: 'app-action',
      appAction: {
        id: OPEN_EMAIL_GENERATION_ACTION_ID,
        version: 2,
        payload: {
          scope,
          sourceTarget: source
            ? {
                type: source.kind,
                id: source.id,
                label: source.label,
              }
            : null,
          email: {
            view: 'generation',
            purpose: request?.purpose || 'generic',
            configuration,
          },
        },
      },
    },
    meta: {
      moduleId: 'facile.renewals',
      intent: 'app-action',
      tool: OPEN_EMAIL_GENERATION_ACTION_ID,
      plannerSource: request?.source || 'deterministic',
      configuredFields: Object.keys(configuration),
    },
  }
}

export function buildOpenEmailGenerationAction({
  request,
  services = [],
  settings = {},
  history = [],
  scope = {},
  actorToken = '',
} = {}) {
  cleanupContexts()

  if (request?.configurationErrors?.length) {
    return {
      ok: true,
      intent: 'clarification',
      source: 'tool-fast',
      reply: ['Non posso applicare la configurazione Email:', ...request.configurationErrors.map(error => `- ${error}`)].join('\n'),
      data: {
        type: 'clarification',
        reason: 'open-email-generation-invalid-configuration',
        errors: request.configurationErrors,
      },
      meta: {
        moduleId: 'facile.renewals',
        intent: 'clarification',
        tool: OPEN_EMAIL_GENERATION_ACTION_ID,
      },
    }
  }

  const resolution = resolveOpenEmailGenerationTarget({
    request,
    services,
    settings,
    history,
    scope,
  })

  if (
    resolution.status === 'missing-target' &&
    hasEmailGenerationConfiguration(request?.configuration)
  ) {
    pendingClarifications.delete(fingerprintToken(actorToken))
    return buildAppActionResult({request, scope: null, source: null})
  }

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
        reason: `open-email-generation-${resolution.status}`,
        candidates: resolution.candidates || [],
      },
      meta: {
        moduleId: 'facile.renewals',
        intent: 'clarification',
        tool: OPEN_EMAIL_GENERATION_ACTION_ID,
      },
    }
  }

  pendingClarifications.delete(fingerprintToken(actorToken))
  return buildAppActionResult({
    request,
    scope: resolution.scope,
    source: resolution.source,
  })
}

export function handlePendingOpenEmailGenerationClarification({
  message = '',
  actorToken = '',
} = {}) {
  cleanupContexts()
  const key = fingerprintToken(actorToken)
  const pending = pendingClarifications.get(key)
  if (!pending) return null

  if (/^(?:annulla|cancella|lascia stare|lascia perdere|stop|no)$/i.test(compactText(message))) {
    pendingClarifications.delete(key)
    return {
      ok: true,
      intent: 'app-action-cancelled',
      source: 'tool-fast',
      reply: 'Apertura della sezione Email annullata.',
      data: {type: 'app-action-cancelled', status: 'cancelled'},
      meta: {
        moduleId: 'facile.renewals',
        intent: 'app-action-cancelled',
        tool: OPEN_EMAIL_GENERATION_ACTION_ID,
      },
    }
  }

  const selected = selectCandidate(message, pending.candidates || [])
  if (!selected && NEW_REQUEST_PATTERN.test(compactText(message))) {
    pendingClarifications.delete(key)
    return null
  }

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
        reason: 'open-email-generation-selection-invalid',
        candidates: pending.candidates || [],
      },
      meta: {
        moduleId: 'facile.renewals',
        intent: 'clarification',
        tool: OPEN_EMAIL_GENERATION_ACTION_ID,
      },
    }
  }

  pendingClarifications.delete(key)
  return buildAppActionResult({
    request: pending.request,
    scope: selected.scope,
    source: selected,
  })
}
