import {queryRenewalsCatalog} from './service.js'
import {normalizeCatalogEntities} from './catalogEntities.js'
import {compactText} from '../../../utils/text.js'
import {ToolContractError} from '../../../core/tools/toolContract.js'

const PAGE_SIZE = 50
const MAX_PAGES = 100
const SORT = [{field: 'name', direction: 'asc'}, {field: 'id', direction: 'asc'}]
const nameKey = value => compactText(value).normalize('NFC').toLocaleLowerCase('it')

// Search owns its backend filters; the catalog-list tool's contract stays unchanged.
async function readCatalog(entity, filters, queryCatalog) {
  const rows = []
  let offset = 0, total
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await queryCatalog({operation: 'list', entity, filters, sort: SORT, limit: PAGE_SIZE, offset})
    if (result?.ok !== true || result.source !== 'catalog' || result.entity !== entity ||
        result.sourceScope !== 'complete-master-data' || !Array.isArray(result.items) ||
        !Number.isInteger(result.total) || result.total < 0 || result.offset !== offset ||
        typeof result.hasMore !== 'boolean' || result.items.length > PAGE_SIZE ||
        (total !== undefined && result.total !== total)) {
      throw new ToolContractError('RENEWALS_CATALOG_INVALID_RESULT', 'La ricerca piani non ha ricevuto un catalogo verificabile.')
    }
    total = result.total
    rows.push(...result.items)
    if (!result.hasMore) {
      if (rows.length === total) return rows
      break
    }
    if (!result.items.length || result.nextOffset !== offset + result.items.length) break
    offset = result.nextOffset
  }
  throw new ToolContractError('RENEWALS_CATALOG_INCOMPLETE', 'La ricerca piani è incompleta; nessun risultato parziale dichiarato completo.')
}

function clarification(reason, supplier, candidates = []) {
  return {type: 'clarification', reason, supplier, candidates}
}

export async function searchRenewalsPlans(args, {queryCatalog = queryRenewalsCatalog} = {}) {
  let supplier
  if (args.supplier !== undefined) {
    const input = compactText(args.supplier).normalize('NFC')
    if (!input) throw new ToolContractError('TOOL_VALIDATION_ERROR', 'Il fornitore deve essere un nome o ID non vuoto.')
    const providers = normalizeCatalogEntities(await readCatalog('providers', [], queryCatalog))
    const byId = providers.find(item => item.id === input)
    const matches = byId ? [byId] : providers.filter(item => nameKey(item.name) === nameKey(input))
    if (!matches.length) return clarification('renewals-plan-supplier-not-found', input)
    if (matches.length > 1) return clarification('renewals-plan-supplier-ambiguous', input, matches)
    supplier = matches[0]
    if (!supplier.id) return clarification('renewals-plan-supplier-id-missing', input, matches)
  }
  const filters = supplier ? [{field: 'supplier.id', operator: 'equals', value: supplier.id}] : []
  const rows = await readCatalog('plans', filters, queryCatalog)
  if (supplier && rows.some(item => String(item?.supplier?.id ?? '') !== supplier.id)) {
    throw new ToolContractError('RENEWALS_CATALOG_INVALID_RESULT', 'Il catalogo non ha rispettato il filtro fornitore.')
  }
  const normalized = normalizeCatalogEntities(rows, 'plan')
  const limit = args.limit ?? 50, offset = args.offset ?? 0
  const items = normalized.slice(offset, offset + limit)
  const hasMore = offset + items.length < normalized.length
  return {type: 'renewals-plans', source: 'catalog', sourceScope: 'complete-master-data',
    ...(supplier ? {supplier} : {}), total: normalized.length, limit, offset, shown: items.length,
    hasMore, nextOffset: hasMore ? offset + items.length : null, items}
}

export const renewalsSearchPlansTool = {
  name: 'renewals_search_plans', moduleId: 'facile.renewals', credential: 'crm',
  requiresPrincipal: true, capabilityId: 'facile.renewals.read', mode: 'read', risk: 'low',
  terminal: true, stateful: true, stateKeys: ['supplier'],
  definition: {type: 'function', function: {
    name: 'renewals_search_plans',
    description: 'Cerca i piani base del catalogo Rinnovi/CRM filtrati per fornitore, esclusi gli addon. Per "quali piani sono di Aruba?" usa supplier="Aruba". Dopo una lista dei piani, "quali sono di Aruba?" ricerca i piani di quel fornitore: non elencare i fornitori. supplier accetta un ID stabile o un nome esatto, normalizzato per spazi e maiuscole; nessun fuzzy matching o sinonimo. Restituisce solo ID, nome e fornitore, con totale e paginazione. Per la semplice lista anagrafica senza filtri preferisci renewals_list_entities(entityType="plan"). Non cerca servizi dei clienti. Non filtra risorse o prezzi, non restituisce dettagli, non calcola piano più economico, ranking o piano con più risorse: queste capacità non sono migrate.',
    parameters: {type: 'object', additionalProperties: false, properties: {
      supplier: {type: 'string', description: 'ID stabile oppure nome esatto non vuoto del fornitore, ad esempio Aruba.'},
      limit: {type: 'integer', minimum: 1, maximum: 50, description: 'Numero di piani da mostrare, massimo 50; predefinito 50.'},
      offset: {type: 'integer', minimum: 0, description: 'Posizione nella ricerca ordinata per nome e ID; predefinito 0.'},
    }},
  }},
  async execute(args) {
    const data = await searchRenewalsPlans(args)
    const reply = data.type === 'clarification'
      ? data.reason === 'renewals-plan-supplier-ambiguous'
        ? `Il nome «${data.supplier}» identifica più fornitori. Specifica l'ID: ${data.candidates.map(item => `${item.name} (${item.id || 'ID non disponibile'})`).join('; ')}.`
        : `Non posso risolvere il fornitore «${data.supplier}» con un ID univoco nel catalogo. Specifica un nome esatto o un ID presente.`
      : [`Piani trovati: ${data.total}.`,
        data.shown < data.total ? `Mostro ${data.shown} risultati dalla posizione ${data.offset + 1}.` : null,
        ...data.items.map(item => `- ${item.name}${item.supplier?.name ? ` · ${item.supplier.name}` : ''}`)].filter(Boolean).join('\n')
    return {ok: true, moduleId: 'facile.renewals', reply, data, modelContent: data}
  },
}
