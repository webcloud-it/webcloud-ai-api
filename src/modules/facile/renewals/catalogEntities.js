import {queryRenewalsCatalog} from './service.js'
import {ToolContractError} from '../../../core/tools/toolContract.js'

const ENTITY_TYPES = {
  supplier: {catalogId: 'providers', label: 'Fornitori', metadata: {}},
  resourceType: {catalogId: 'resources', label: 'Tipi di risorsa',
    metadata: {category: 'category', unit: 'unitOfMeasurement'}},
  plan: {catalogId: 'plans', label: 'Piani base', metadata: {}, supplier: true},
}
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

function entityDefinition(entityType) {
  if (!Object.hasOwn(ENTITY_TYPES, entityType)) {
    throw new ToolContractError('TOOL_VALIDATION_ERROR', 'Entità non supportata dalla lista catalogo.')
  }
  return ENTITY_TYPES[entityType]
}

// Optional text metadata is projected from verified datasource fields only.
// Duplicate rows retain a deterministic existing value, independently of row order.
function mergeMetadata(left, right, fields, withSupplier = false) {
  const result = Object.fromEntries(Object.keys(fields).flatMap(field => {
    const value = [left?.[field], right?.[field]].filter(Boolean).sort(compare)[0]
    return value ? [[field, value]] : []
  }))
  if (withSupplier) {
    // Choose a complete existing reference; never combine an ID with another supplier's name.
    const supplier = [left?.supplier, right?.supplier].filter(Boolean).sort((a, b) =>
      Number(Boolean(b.id)) - Number(Boolean(a.id)) || compare(a.id || '', b.id || '') || compare(a.name, b.name))[0]
    if (supplier) result.supplier = supplier
  }
  return result
}

function normalizeSupplier(value) {
  const name = scalar(value?.name), id = scalar(value?.id)
  return name ? {...(id ? {id} : {}), name} : undefined
}

// IDs are authoritative. A nameless-ID row keeps its ID as a display label.
// Name-only rows join an identified row only when that name identifies one ID.
// Distinct IDs with the same name remain distinct; no fuzzy matching is used.
export function normalizeCatalogEntities(rows = [], entityType = 'supplier') {
  const {metadata, supplier: withSupplier} = entityDefinition(entityType)
  const identified = new Map(), anonymous = new Map()
  for (const row of rows) {
    const id = scalar(row?.id), name = scalar(row?.name ?? row?.label)
    if (!id && !name) continue
    const map = id ? identified : anonymous
    const key = id || nameKey(name)
    const candidate = {...(id ? {id} : {}), name: name || id, named: Boolean(name)}
    const previous = map.get(key)
    const projected = Object.fromEntries(Object.entries(metadata).flatMap(([field, sourceField]) => {
      const value = typeof row?.[sourceField] === 'string' ? scalar(row[sourceField]) : ''
      return value ? [[field, value]] : []
    }))
    if (withSupplier) projected.supplier = normalizeSupplier(row?.supplier)
    const preferred = !previous || (name && !previous.named) ||
      (candidate.named === previous.named && compare(candidate.name, previous.name) < 0) ? candidate : previous
    map.set(key, {...preferred, ...mergeMetadata(previous, projected, metadata, withSupplier)})
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
    if (nameIds.get(key)?.size === 1) {
      const identifiedRow = identified.get(nameIds.get(key).values().next().value)
      Object.assign(identifiedRow, mergeMetadata(identifiedRow, anonymous.get(key), metadata, withSupplier))
      anonymous.delete(key)
    }
  }
  return [...identified.values(), ...anonymous.values()].map(({named, ...item}) => item).sort((a, b) =>
    compare(nameKey(a.name), nameKey(b.name)) || compare(a.name, b.name) || compare(a.id || '', b.id || ''))
}

export async function listRenewalsEntities(args, {queryCatalog = queryRenewalsCatalog} = {}) {
  const entity = entityDefinition(args.entityType)
  const rows = []
  let offset = 0, sourceTotal
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await queryCatalog({operation: 'list', entity: entity.catalogId,
      filters: [], sort: [{field: 'name', direction: 'asc'}, {field: 'id', direction: 'asc'}],
      limit: PAGE_SIZE, offset})
    if (result?.ok !== true || result.source !== 'catalog' || result.entity !== entity.catalogId ||
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
      const normalized = normalizeCatalogEntities(rows, args.entityType)
      const limit = args.limit ?? 50, start = args.offset ?? 0
      const items = normalized.slice(start, start + limit)
      return {type: 'renewals-entity-list', entityType: args.entityType, entityLabel: entity.label,
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
    description: 'Elenca esclusivamente le anagrafiche del catalogo Rinnovi/CRM, deduplicate e ordinate per nome. entityType=supplier elenca i fornitori con ID e nome; entityType=resourceType elenca i tipi di risorsa con ID, nome e, quando presenti, categoria e unità di misura; entityType=plan elenca i piani base con ID, nome e fornitore quando disponibile, escludendo gli addon. Il totale indica il numero di anagrafiche trovate; limit e offset paginano la lista completa. Non cerca servizi né entità associate a un cliente. Non applica filtri per fornitore, risorse o prezzi e non restituisce dettagli delle risorse o dei listini. Non calcola conteggi operativi, non produce ranking e non esegue aggregazioni o join: queste analisi sono capacità non migrate in questo tool.',
    parameters: {type: 'object', additionalProperties: false, required: ['entityType'], properties: {
      entityType: {type: 'string', enum: ['supplier', 'resourceType', 'plan'], description: 'Anagrafica completa: supplier=fornitori; resourceType=tipi di risorsa; plan=piani base, esclusi addon.'},
      limit: {type: 'integer', minimum: 1, maximum: 50, description: 'Numero di entità da mostrare, massimo 50; predefinito 50.'},
      offset: {type: 'integer', minimum: 0, description: 'Posizione nella lista deduplicata ordinata; predefinito 0.'},
    }},
  }},
  async execute(args) {
    const data = await listRenewalsEntities(args)
    const reply = [`${data.entityLabel} trovati: ${data.total}.`,
      data.shown < data.total ? `Mostro ${data.shown} risultati dalla posizione ${data.offset + 1}.` : null,
      ...data.items.map(item => `- ${item.name}${item.supplier?.name ? ` · ${item.supplier.name}` : ''}`)].filter(Boolean).join('\n')
    return {ok: true, moduleId: 'facile.renewals', reply, data, modelContent: data}
  },
}
