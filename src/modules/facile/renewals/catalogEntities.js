import {queryRenewalsCatalog} from './service.js'
import {ToolContractError} from '../../../core/tools/toolContract.js'

const SUPPLIER = {catalogId: 'providers', label: 'Fornitori'}
const PAGE_SIZE = 50
const MAX_PAGES = 100

function scalar(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).normalize('NFC').trim().replace(/\s+/gu, ' ') : ''
}
function nameKey(value) {return value.toLocaleLowerCase('it')}
function compare(left, right) {
  return left.localeCompare(right, 'it') || (left < right ? -1 : left > right ? 1 : 0)
}

// IDs are authoritative. A nameless-ID row keeps its ID as a display label.
// Name-only rows join an identified row only when that name identifies one ID.
// Distinct IDs with the same name remain distinct; no fuzzy matching is used.
export function normalizeCatalogEntities(rows = []) {
  const identified = new Map(), anonymous = new Map()
  for (const row of rows) {
    const id = scalar(row?.id), name = scalar(row?.name ?? row?.label)
    if (!id && !name) continue
    const map = id ? identified : anonymous
    const key = id || nameKey(name)
    const candidate = {...(id ? {id} : {}), name: name || id, named: Boolean(name)}
    const previous = map.get(key)
    if (!previous || (name && !previous.named) ||
        (candidate.named === previous.named && compare(candidate.name, previous.name) < 0)) map.set(key, candidate)
  }
  const nameIds = new Map()
  for (const row of rows) {
    const id = scalar(row?.id), name = scalar(row?.name ?? row?.label)
    if (!id || !name) continue
    const key = nameKey(name)
    if (!nameIds.has(key)) nameIds.set(key, new Set())
    nameIds.get(key).add(id)
  }
  for (const key of anonymous.keys()) {
    if (nameIds.get(key)?.size === 1) anonymous.delete(key)
  }
  return [...identified.values(), ...anonymous.values()].map(({named, ...item}) => item).sort((a, b) =>
    compare(nameKey(a.name), nameKey(b.name)) || compare(a.name, b.name) || compare(a.id || '', b.id || ''))
}

export async function listRenewalsEntities(args, {queryCatalog = queryRenewalsCatalog} = {}) {
  if (args.entityType !== 'supplier') {
    throw new ToolContractError('TOOL_VALIDATION_ERROR', 'Entità non supportata dalla lista catalogo.')
  }
  const rows = []
  let offset = 0, sourceTotal
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await queryCatalog({operation: 'list', entity: SUPPLIER.catalogId,
      filters: [], sort: [{field: 'name', direction: 'asc'}, {field: 'id', direction: 'asc'}],
      limit: PAGE_SIZE, offset})
    if (result?.ok !== true || result.source !== 'catalog' || result.entity !== SUPPLIER.catalogId ||
        result.sourceScope !== 'complete-master-data' || !Array.isArray(result.items) ||
        !Number.isInteger(result.total) || result.total < 0 || result.offset !== offset ||
        typeof result.hasMore !== 'boolean' || result.items.length > PAGE_SIZE ||
        (sourceTotal !== undefined && result.total !== sourceTotal)) {
      throw new ToolContractError('RENEWALS_CATALOG_INVALID_RESULT', 'Il catalogo non ha restituito una lista completa verificabile.')
    }
    sourceTotal = result.total
    rows.push(...result.items)
    if (!result.hasMore) {
      if (rows.length !== sourceTotal) break
      const normalized = normalizeCatalogEntities(rows)
      const limit = args.limit ?? 50, start = args.offset ?? 0
      const items = normalized.slice(start, start + limit)
      return {type: 'renewals-entity-list', entityType: args.entityType, entityLabel: SUPPLIER.label,
        source: 'catalog', sourceScope: 'complete-master-data', sourceTotal, total: normalized.length,
        shown: items.length, offset: start, limit, hasMore: start + items.length < normalized.length,
        nextOffset: start + items.length < normalized.length ? start + items.length : null, items}
    }
    if (!result.items.length || result.nextOffset !== offset + result.items.length) break
    offset = result.nextOffset
  }
  throw new ToolContractError('RENEWALS_CATALOG_INCOMPLETE', 'La lista catalogo non è completa; nessun risultato parziale dichiarato completo.')
}

export const renewalsListEntitiesTool = {
  name: 'renewals_list_entities', moduleId: 'facile.renewals', credential: 'crm',
  requiresPrincipal: true, capabilityId: 'facile.renewals.read', mode: 'read', risk: 'low',
  terminal: true, stateful: false,
  definition: {type: 'function', function: {
    name: 'renewals_list_entities',
    description: 'Elenca le entità anagrafiche presenti nel catalogo Rinnovi/CRM. In questa versione entityType=supplier restituisce tutti i fornitori del catalogo, deduplicati e ordinati per nome, con ID e nome. Per liste di fornitori usa questo tool. Non cerca servizi, non filtra i fornitori usati da un cliente e non calcola conteggi o classifiche di servizi per fornitore: queste analisi non sono migrate in questo tool.',
    parameters: {type: 'object', additionalProperties: false, required: ['entityType'], properties: {
      entityType: {type: 'string', enum: ['supplier'], description: 'supplier: anagrafica completa dei fornitori.'},
      limit: {type: 'integer', minimum: 1, maximum: 50, description: 'Numero di entità da mostrare, massimo 50; predefinito 50.'},
      offset: {type: 'integer', minimum: 0, description: 'Posizione nella lista deduplicata ordinata; predefinito 0.'},
    }},
  }},
  async execute(args) {
    const data = await listRenewalsEntities(args)
    const reply = [`${data.entityLabel} trovati: ${data.total}.`,
      data.shown < data.total ? `Mostro ${data.shown} risultati dalla posizione ${data.offset + 1}.` : null,
      ...data.items.map(item => `- ${item.name}`)].filter(Boolean).join('\n')
    return {ok: true, moduleId: 'facile.renewals', reply, data, modelContent: data}
  },
}
