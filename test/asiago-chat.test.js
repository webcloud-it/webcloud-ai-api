import test from 'node:test'
import assert from 'node:assert/strict'

import {handleAsiagoChat} from '../src/modules/facile/asiago/chat.js'

function services(overrides = {}) {
  return {
    getEvents: async () => ({items: [], total: 0}),
    getContents: async () => ({items: [], total: 0}),
    getMinisites: async () => ({items: [], total: 0}),
    getSnowResorts: async () => ({items: [], total: 0}),
    getPricelists: async () => ({items: [], total: 0}),
    getRedirects: async () => ({items: [], total: 0}),
    ...overrides,
  }
}

test('lists upcoming Asiago events without model inference', async () => {
  let received = null
  const result = await handleAsiagoChat({
    message: 'Mostrami i prossimi eventi di Asiago',
    token: 'cms-token',
    services: services({
      getEvents: async options => {
        received = options
        return {items: [{id: 42, title: 'Festa del Bosco', published: true, event: {startDate: '2026-08-20'}}], total: 1}
      },
    }),
  })

  assert.equal(result.intent, 'asiago-events')
  assert.equal(received.upcoming, true)
  assert.match(result.reply, /Festa del Bosco/)
})

test('resolves an explicit event id and opens its page', async () => {
  let received = null
  const result = await handleAsiagoChat({
    message: 'Apri evento 123',
    token: 'cms-token',
    services: services({
      getEvents: async options => {
        received = options
        return {items: [{id: 123, title: 'Evento test', published: false, event: {}}], total: 1}
      },
    }),
  })

  assert.equal(result.intent, 'app-action')
  assert.equal(received.eventId, '123')
  assert.equal(result.data.appAction.path, '/asiagoit/events/123')
})

test('opens a uniquely named minisite and disambiguates similar names', async () => {
  const unique = await handleAsiagoChat({
    message: 'apri il minisito Hotel Europa',
    token: 'cms-token',
    services: services({getMinisites: async () => ({items: [{id: 9, name: 'Hotel Europa', category: {name: 'Hotel'}}], total: 1})}),
  })
  assert.equal(unique.intent, 'app-action')
  assert.equal(unique.data.appAction.path, '/asiagoit/minisites/9')

  const ambiguous = await handleAsiagoChat({
    message: 'apri il minisito Europa',
    token: 'cms-token',
    services: services({getMinisites: async () => ({items: [
      {id: 9, name: 'Hotel Europa', category: {name: 'Hotel'}},
      {id: 10, name: 'Residence Europa', category: {name: 'Residence'}},
    ], total: 2})}),
  })
  assert.equal(ambiguous.intent, 'asiago-minisites-open-ambiguous')
  assert.equal(ambiguous.data.items.length, 2)
})

test('searches minisites using only an explicitly quoted query', async () => {
  let received = null
  const result = await handleAsiagoChat({
    message: 'Cerca il minisito "Hotel Europa"',
    token: 'cms-token',
    services: services({
      getMinisites: async options => {
        received = options
        return {items: [{id: 9, name: 'Hotel Europa', category: {name: 'Hotel'}}], total: 1}
      },
    }),
  })

  assert.equal(result.intent, 'asiago-minisites')
  assert.equal(received.search, 'Hotel Europa')
  assert.match(result.reply, /Hotel Europa/)
})

test('extracts a natural unquoted search after a search command', async () => {
  let received = null
  await handleAsiagoChat({
    message: 'Cerca il minisito Hotel Europa',
    token: 'cms-token',
    services: services({getMinisites: async options => {
      received = options
      return {items: [], total: 0}
    }}),
  })
  assert.equal(received.search, 'Hotel Europa')
})

test('builds the Asiago summary with bounded parallel reads', async () => {
  const result = await handleAsiagoChat({
    message: 'Fammi una panoramica del CMS Asiago',
    token: 'cms-token',
    services: services({
      getEvents: async () => ({items: [], total: 7}),
      getContents: async () => ({items: [], total: 120}),
      getMinisites: async () => ({items: [], total: 34}),
    }),
  })

  assert.equal(result.intent, 'asiago-summary')
  assert.deepEqual(result.data.totals, {upcomingEvents: 7, contents: 120, minisites: 34})
})

test('reads snow bulletin status with its dedicated credential and no API keys', async () => {
  let received = null
  const result = await handleAsiagoChat({
    message: 'Mostrami il bollettino neve',
    token: 'cms-token',
    credentials: {cmsAsiagoIt: 'cms-token', snowbulletin: 'snow-token'},
    services: services({
      getSnowResorts: async options => {
        received = options
        return {items: [{id: 'r1', name: 'Kaberlaba', portalVisible: true, integrations: {total: 2, enabled: 2}, apiKey: undefined}], total: 1}
      },
    }),
  })

  assert.equal(result.intent, 'asiago-snow-resorts')
  assert.equal(received.token, 'snow-token')
  assert.equal(JSON.stringify(result).includes('snow-token'), false)
})

test('fails closed when a secondary Asiago credential is unavailable', async () => {
  const result = await handleAsiagoChat({
    message: 'Elenca i redirect',
    token: 'cms-token',
    credentials: {cmsAsiagoIt: 'cms-token'},
    services: services(),
  })

  assert.equal(result.intent, 'unavailable')
  assert.equal(result.data.credential, 'nozomi')
})

test('fails closed for CMS reads when only a secondary credential is available', async () => {
  const result = await handleAsiagoChat({
    message: 'Mostrami gli eventi',
    credentials: {snowbulletin: 'snow-token'},
    services: services(),
  })
  assert.equal(result.intent, 'unavailable')
  assert.equal(result.data.credential, 'cmsAsiagoIt')
})

test('lists safe pricelist accommodations and active redirects', async () => {
  const pricelists = await handleAsiagoChat({
    message: 'Elenca i listini',
    credentials: {spine01: 'spine-token'},
    services: services({getPricelists: async () => ({items: [{id: 1, name: 'Hotel Europa'}], total: 1})}),
  })
  assert.equal(pricelists.intent, 'asiago-pricelists')
  assert.match(pricelists.reply, /Hotel Europa/)

  const redirects = await handleAsiagoChat({
    message: 'Cerca redirect "vecchia-pagina"',
    credentials: {nozomi: 'nozomi-token'},
    services: services({getRedirects: async () => ({items: [{id: 2, fromPath: '/vecchia-pagina', toUrl: '/nuova'}], total: 1})}),
  })
  assert.equal(redirects.intent, 'asiago-redirects')
  assert.match(redirects.reply, /vecchia-pagina/)
})
