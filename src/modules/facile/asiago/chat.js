import {normalizeText} from '../../../utils/text.js'
import {
  extractEntityTarget,
  isOpenEntityRequest,
  resolveNamedEntity,
} from '../../../core/entities/entityResolver.js'
import {getContents, getEvents, getMinisites, getPricelists, getRedirects, getSnowResorts} from './service.js'

function quotedValue(message = '') {
  return String(message).match(/["“”']([^"“”']{2,80})["“”']/)?.[1]?.trim() || ''
}

function requestedSearch(message = '', entityPattern = '') {
  const quoted = quotedValue(message)
  if (quoted) return quoted
  if (isOpenEntityRequest(message)) return extractEntityTarget(message) || ''
  const command = String(message).match(/\b(?:cerca|trova|filtra)\b\s+(.+)$/i)?.[1] || ''
  if (!command) return ''
  let value = command
    .replace(/^(?:il|lo|la|i|gli|le|un|uno|una)\s+/i, '')
    .replace(new RegExp(`^(?:${entityPattern})\\s*`, 'i'), '')
    .replace(/\b(?:di|su)\s+asiago(?:\.it)?\b/gi, '')
    .replace(/^(?:di|su|per)\s+/i, '')
    .replace(/[?.!]+$/g, '')
    .trim()
  return value.length >= 2 ? value : ''
}

function openEntityResponse({message, payload, type, label, path, fields}) {
  if (!isOpenEntityRequest(message)) return null
  const target = extractEntityTarget(message)
  const resolution = resolveNamedEntity({items: payload.items || [], query: target, fields})

  if (resolution.status === 'resolved') {
    const item = resolution.item
    const targetPath = path(item)
    return {
      ok: true,
      intent: 'app-action',
      source: 'tool-fast',
      reply: `Apro ${label(item)}.`,
      data: {
        type: 'app-action',
        appAction: {id: 'navigate', label: `Apri ${label(item)}`, path: targetPath},
        entity: {id: item.id, name: label(item), type},
      },
      meta: {moduleId: 'facile.asiago'},
    }
  }

  if (resolution.status === 'ambiguous') {
    const items = resolution.candidates.map(candidate => candidate.item)
    return {
      ok: true,
      intent: `${type}-open-ambiguous`,
      source: 'tool-fast',
      reply: [`Ho trovato più risultati per “${target}”. Scegli quello corretto:`, ...items.map((item, index) => `${index + 1}. ${label(item)}`)].join('\n'),
      data: {type, query: {search: target, intent: 'open'}, ...payload, total: items.length, items},
      meta: {moduleId: 'facile.asiago'},
    }
  }

  return null
}

function explicitId(message = '', nounPattern = '(?:evento|articolo|contenuto)') {
  return String(message).match(new RegExp(`\\b(?:id\\s*[:#]?\\s*|${nounPattern}\\s+#?)(\\d+)\\b`, 'i'))?.[1] || null
}

function formatArticles(payload, label) {
  if (!payload.items.length) return `Non ho trovato ${label.toLowerCase()} corrispondenti.`
  return [
    `Ho trovato ${payload.total} ${label.toLowerCase()}.`,
    ...payload.items.map((item, index) => {
      const date = item.event?.startDate ? ` — ${item.event.startDate}` : ''
      const status = item.published ? 'pubblicato' : 'bozza'
      return `${index + 1}. ${item.title}${date} [${status}]`
    }),
  ].join('\n')
}

function formatMinisites(payload) {
  if (!payload.items.length) return 'Non ho trovato minisiti corrispondenti.'
  return [
    `Ho trovato ${payload.total} minisiti.`,
    ...payload.items.map((item, index) => `${index + 1}. ${item.name}${item.category.name ? ` — ${item.category.name}` : ''}`),
  ].join('\n')
}

export async function handleAsiagoChat({
  message,
  token,
  credentials = {},
  services = {getContents, getEvents, getMinisites, getPricelists, getRedirects, getSnowResorts},
} = {}) {
  const text = normalizeText(message)
  const cmsToken = credentials.cmsAsiagoIt || token

  if (/\b(bollettino(?:\s+neve)?|neve|comprensori?\s+sciistic[oi]|ski\s*resort)\b/.test(text)) {
    if (!credentials.snowbulletin) {
      return {ok: true, intent: 'unavailable', source: 'tool-fast', reply: 'La sessione non dispone della credenziale del bollettino neve. Ricarica Facile o verifica i permessi dell’account.', data: {type: 'capability-unavailable', credential: 'snowbulletin'}, meta: {moduleId: 'facile.asiago'}}
    }
    const search = requestedSearch(message, '(?:il\\s+)?(?:bollettino(?:\\s+neve)?|comprensori?|ski\\s*resort)')
    const payload = await services.getSnowResorts({token: credentials.snowbulletin, search, limit: 20})
    const lines = payload.items.map((item, index) => `${index + 1}. ${item.name}${item.location ? ` — ${item.location}` : ''} [portale ${item.portalVisible ? 'attivo' : 'non attivo'}]`)
    return {ok: true, intent: 'asiago-snow-resorts', source: 'tool-fast', reply: lines.length ? [`Bollettino neve: ${payload.total} comprensori.`, ...lines].join('\n') : 'Non ho trovato comprensori corrispondenti.', data: {type: 'asiago-snow-resorts', query: {search}, ...payload, actions: [{id: 'navigate', label: 'Apri bollettino neve', path: '/asiagoit/snowbulletin'}]}, meta: {moduleId: 'facile.asiago'}}
  }

  if (/\b(listini?|prezzari?)\b/.test(text)) {
    if (!credentials.spine01) {
      return {ok: true, intent: 'unavailable', source: 'tool-fast', reply: 'La sessione non dispone della credenziale dei listini Asiago.it. Ricarica Facile o verifica i permessi dell’account.', data: {type: 'capability-unavailable', credential: 'spine01'}, meta: {moduleId: 'facile.asiago'}}
    }
    const search = requestedSearch(message, '(?:i\\s+)?(?:listini?|prezzari?)')
    const payload = await services.getPricelists({token: credentials.spine01, search, limit: 20})
    return {ok: true, intent: 'asiago-pricelists', source: 'tool-fast', reply: payload.items.length ? [`Ho trovato ${payload.total} strutture nella sezione listini.`, ...payload.items.map((item, index) => `${index + 1}. ${item.name}`)].join('\n') : 'Non ho trovato strutture corrispondenti nei listini.', data: {type: 'asiago-pricelists', query: {search}, ...payload, actions: [{id: 'navigate', label: 'Apri listini', path: '/asiagoit/pricelists'}]}, meta: {moduleId: 'facile.asiago'}}
  }

  if (/\bredirects?|reindirizzament[oi]\b/.test(text)) {
    if (!credentials.nozomi) {
      return {ok: true, intent: 'unavailable', source: 'tool-fast', reply: 'La sessione non dispone della credenziale Nozomi necessaria per i redirect. Ricarica Facile o verifica i permessi dell’account.', data: {type: 'capability-unavailable', credential: 'nozomi'}, meta: {moduleId: 'facile.asiago'}}
    }
    const search = requestedSearch(message, '(?:i\\s+)?(?:redirects?|reindirizzamenti?)')
    const payload = await services.getRedirects({token: credentials.nozomi, search, limit: 20})
    const openResult = openEntityResponse({message, payload, type: 'asiago-redirects', label: item => item.fromPath || item.toUrl || String(item.id), path: item => `/asiagoit/redirects/${encodeURIComponent(String(item.id))}`, fields: [{value: 'fromPath', weight: 18}, {value: 'toUrl', weight: 12}, {value: 'id', weight: 20}]})
    if (openResult) return openResult
    return {ok: true, intent: 'asiago-redirects', source: 'tool-fast', reply: payload.items.length ? [`Ho trovato ${payload.total} redirect attivi.`, ...payload.items.map((item, index) => `${index + 1}. ${item.fromPath || '—'} → ${item.toUrl || '—'}`)].join('\n') : 'Non ho trovato redirect attivi corrispondenti.', data: {type: 'asiago-redirects', query: {search}, ...payload, actions: [{id: 'navigate', label: 'Apri redirect', path: '/asiagoit/redirects'}]}, meta: {moduleId: 'facile.asiago'}}
  }

  if (!cmsToken) {
    return {ok: true, intent: 'unavailable', source: 'tool-fast', reply: 'La sessione non dispone della credenziale CMS Asiago.it. Ricarica Facile o verifica i permessi dell’account.', data: {type: 'capability-unavailable', credential: 'cmsAsiagoIt'}, meta: {moduleId: 'facile.asiago'}}
  }

  if (/\b(riassunto|riepilogo|panoramica|dashboard|situazione)\b/.test(text)) {
    const [events, contents, minisites] = await Promise.all([
      services.getEvents({token: cmsToken, upcoming: true, limit: 5}),
      services.getContents({token: cmsToken, limit: 5}),
      services.getMinisites({token: cmsToken, limit: 5}),
    ])
    return {
      ok: true,
      intent: 'asiago-summary',
      source: 'tool-fast',
      reply: `Asiago.it: ${events.total} eventi futuri, ${contents.total} altri contenuti e ${minisites.total} minisiti accessibili con il tuo account.`,
      data: {type: 'asiago-summary', totals: {upcomingEvents: events.total, contents: contents.total, minisites: minisites.total}},
      meta: {moduleId: 'facile.asiago'},
    }
  }

  if (/\b(minisit[oi]|struttur[ae]|hotel)\b/.test(text)) {
    const search = requestedSearch(message, '(?:il\\s+)?(?:minisit[oi]|struttur[ae]|hotel)')
    const payload = await services.getMinisites({token: cmsToken, search, limit: 20})
    const openResult = openEntityResponse({message, payload, type: 'asiago-minisites', label: item => item.name || String(item.id), path: item => `/asiagoit/minisites/${encodeURIComponent(String(item.id))}`, fields: [{value: 'name', weight: 18}, {value: 'id', weight: 20}, {value: item => item.category?.name, weight: 5}]})
    if (openResult) return openResult
    return {
      ok: true,
      intent: 'asiago-minisites',
      source: 'tool-fast',
      reply: formatMinisites(payload),
      data: {type: 'asiago-minisites', query: {search}, ...payload, actions: [{id: 'navigate', label: 'Apri minisiti', path: '/asiagoit/minisites'}]},
      meta: {moduleId: 'facile.asiago'},
    }
  }

  if (/\b(event[oi]|manifestazion[ei])\b/.test(text)) {
    const search = requestedSearch(message, '(?:gli\\s+|i\\s+)?(?:event[oi]|manifestazion[ei])')
    const eventId = explicitId(message, '(?:evento)')
    const upcoming = /\b(prossim[oi]|futur[oi]|in programma|da oggi)\b/.test(text)
    const payload = await services.getEvents({token: cmsToken, search, upcoming, eventId, limit: eventId ? 1 : 20})
    const openResult = openEntityResponse({message, payload, type: 'asiago-events', label: item => item.title || String(item.id), path: item => `/asiagoit/events/${encodeURIComponent(String(item.id))}`, fields: [{value: 'title', weight: 18}, {value: 'id', weight: 20}, {value: 'subtitle', weight: 6}]})
    if (openResult) return openResult
    return {
      ok: true,
      intent: eventId ? 'asiago-event-detail' : 'asiago-events',
      source: 'tool-fast',
      reply: formatArticles(payload, eventId ? 'Eventi' : 'Eventi'),
      data: {type: eventId ? 'asiago-event-detail' : 'asiago-events', query: {search, upcoming, eventId}, ...payload, actions: [{id: 'navigate', label: 'Apri eventi', path: '/asiagoit/events'}]},
      meta: {moduleId: 'facile.asiago'},
    }
  }

  if (/\b(contenut[oi]|articol[oi]|notizi[ae])\b/.test(text)) {
    const search = requestedSearch(message, '(?:i\\s+|gli\\s+|le\\s+)?(?:contenut[oi]|articol[oi]|notizi[ae])')
    const contentId = explicitId(message)
    const payload = await services.getContents({token: cmsToken, search, contentId, limit: contentId ? 1 : 20})
    return {
      ok: true,
      intent: contentId ? 'asiago-content-detail' : 'asiago-contents',
      source: 'tool-fast',
      reply: formatArticles(payload, 'Contenuti'),
      data: {type: contentId ? 'asiago-content-detail' : 'asiago-contents', query: {search, contentId}, ...payload, actions: [{id: 'navigate', label: 'Apri contenuti', path: '/asiagoit/contents'}]},
      meta: {moduleId: 'facile.asiago'},
    }
  }

  return {
    ok: true,
    intent: 'clarification',
    source: 'tool-fast',
    reply: 'Posso consultare eventi, altri contenuti, minisiti, bollettino neve, listini e redirect di Asiago.it. Quale area vuoi controllare?',
    data: {type: 'clarification', reason: 'asiago-area-required'},
    meta: {moduleId: 'facile.asiago'},
  }
}
