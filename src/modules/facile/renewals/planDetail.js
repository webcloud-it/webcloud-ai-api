import {queryRenewalsCatalog} from './service.js'
import {normalizeCatalogEntities} from './catalogEntities.js'
import {compactText} from '../../../utils/text.js'
import {ToolContractError} from '../../../core/tools/toolContract.js'

const PAGE_SIZE = 50
const MAX_PAGES = 100
const nameKey = value => compactText(value).normalize('NFC').toLocaleLowerCase('it')
const scalar = value => typeof value === 'string' || typeof value === 'number'
  ? compactText(String(value)).normalize('NFC') : ''
const invalid = () => new ToolContractError('RENEWALS_PLAN_INVALID_RESULT', 'Il catalogo non ha restituito un dettaglio piano verificabile.')

function verifyPage(result, offset, limit, total) {
  if (result?.ok !== true || result.entity !== 'plans' || result.source !== 'catalog' ||
      result.sourceScope !== 'complete-master-data' || !Array.isArray(result.items) ||
      !Number.isInteger(result.total) || result.total < 0 || result.offset !== offset ||
      typeof result.hasMore !== 'boolean' || result.items.length > limit ||
      (total !== undefined && result.total !== total)) throw invalid()
}

// Resolve against the complete base-plan catalog, projecting each page immediately.
// Only the selected ID is read as detail; no catalog of rich plans reaches the model.
async function resolvePlans(input, queryCatalog) {
  const candidates = []
  let offset = 0, total, count = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await queryCatalog({operation: 'list', entity: 'plans', filters: [],
      sort: [{field: 'name', direction: 'asc'}, {field: 'id', direction: 'asc'}], limit: PAGE_SIZE, offset})
    verifyPage(result, offset, PAGE_SIZE, total)
    total = result.total; count += result.items.length
    candidates.push(...normalizeCatalogEntities(result.items, 'plan'))
    if (!result.hasMore) {
      if (count !== total) break
      const normalized = normalizeCatalogEntities(candidates, 'plan')
      const byId = normalized.find(item => item.id === input)
      return byId ? [byId] : normalized.filter(item => nameKey(item.name) === nameKey(input))
    }
    if (!result.items.length || result.nextOffset !== offset + result.items.length) break
    offset = result.nextOffset
  }
  throw new ToolContractError('RENEWALS_CATALOG_INCOMPLETE', 'La risoluzione del piano è incompleta; nessuna scelta su un catalogo parziale.')
}

function reference(row) {
  const name = scalar(row?.name), id = scalar(row?.id)
  return name ? {...(id ? {id} : {}), name} : undefined
}
function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return undefined
  if (!['number', 'string'].includes(typeof value) || !String(value).trim() || !Number.isFinite(Number(value))) throw invalid()
  return Number(value)
}
function boundedRows(value) {
  if (!Array.isArray(value) || value.length > 50) throw invalid()
  return value
}
function ordered(rows) {
  return [...new Map(rows.map(row => [JSON.stringify(row), row])).values()].sort((a, b) =>
    (a.name || a.priceListVersion?.name || '').localeCompare(b.name || b.priceListVersion?.name || '', 'it') ||
    JSON.stringify(a).localeCompare(JSON.stringify(b), 'it'))
}

export function normalizePlanDetail(row) {
  const id = scalar(row?.id), name = scalar(row?.name)
  if (!id || !name || row.kind !== 'base' || row.isAddon !== false || ![1, '1', 'base'].includes(row.type) || typeof row.missingPrice !== 'boolean') throw invalid()
  const supplier = reference(row.supplier)
  const duration = optionalNumber(row.duration)
  if (duration !== undefined && (!Number.isInteger(duration) || duration < 0)) throw invalid()
  const resources = ordered(boundedRows(row.resources).map(resource => {
    const ref = reference(resource)
    if (!ref) throw invalid()
    const category = scalar(resource.category), unit = scalar(resource.unitOfMeasurement)
    const amount = optionalNumber(resource.amount)
    return {...ref, ...(category ? {category} : {}), ...(unit ? {unit} : {}),
      ...(amount !== undefined ? {amount} : {})}
  }))
  const serviceTypesIn = normalizeCatalogEntities(boundedRows(row.servicesTypesIn))
  const serviceTypesOut = normalizeCatalogEntities(boundedRows(row.servicesTypesOut))
  const entries = ordered(boundedRows(row.priceEntries).map(entry => {
    const entryId = scalar(entry?.id), amount = optionalNumber(entry?.price)
    const ref = reference(entry?.priceListVersion), version = entry?.priceListVersion?.version
    const normalizedVersion = typeof version === 'number' && Number.isFinite(version) || typeof version === 'string' && version.trim()
      ? version : undefined
    return {...(entryId ? {id: entryId} : {}), ...(amount !== undefined ? {amount} : {}),
      ...(ref ? {priceListVersion: {...ref, ...(normalizedVersion !== undefined ? {version: normalizedVersion} : {})}} : {})}
  }))
  if (row.missingPrice !== !entries.some(entry => entry.amount !== undefined)) throw invalid()
  const description = typeof row.description === 'string' ? row.description.normalize('NFC').trim() : ''
  const data = {type: 'renewals-plan', source: 'catalog', sourceScope: 'complete-master-data', id, name,
    ...(supplier ? {supplier} : {}), ...(description ? {description} : {}),
    ...(duration !== undefined ? {durationMonths: duration} : {}), resources, serviceTypesIn, serviceTypesOut,
    pricing: {missing: row.missingPrice, entries}}
  if (description.length > 2000 || Buffer.byteLength(JSON.stringify(data)) > 24000) {
    throw new ToolContractError('RENEWALS_PLAN_DETAIL_TOO_LARGE', 'Il dettaglio piano supera il limite verificabile; nessun dettaglio troncato presentato come completo.')
  }
  return data
}

export async function getRenewalsPlan(args, {queryCatalog = queryRenewalsCatalog} = {}) {
  const input = scalar(args.plan)
  if (!input) throw new ToolContractError('TOOL_VALIDATION_ERROR', 'plan deve identificare un piano base tramite ID o nome esatto non vuoto.')
  const candidates = await resolvePlans(input, queryCatalog)
  if (!candidates.length) return {type: 'clarification', code: 'NOT_FOUND', reason: 'renewals-plan-not-found', plan: input, candidates: []}
  if (candidates.length > 1) return {type: 'clarification', code: 'AMBIGUOUS', reason: 'renewals-plan-ambiguous',
    plan: input, total: candidates.length, candidates: candidates.slice(0, 50)}
  if (!candidates[0].id) throw invalid()
  const result = await queryCatalog({operation: 'detail', entity: 'plans',
    filters: [{field: 'id', operator: 'equals', value: candidates[0].id}],
    sort: [{field: 'id', direction: 'asc'}], limit: 1, offset: 0})
  verifyPage(result, 0, 1)
  if (result.total !== 1 || result.items.length !== 1 || result.hasMore || scalar(result.items[0]?.id) !== candidates[0].id) throw invalid()
  return normalizePlanDetail(result.items[0])
}

export function planPriceLabel(entry) {
  const ref = entry.priceListVersion
  return `${ref?.name || 'Listino non specificato'}${ref?.version !== undefined ? ` · versione ${ref.version}` : ''}: ${entry.amount !== undefined
    ? entry.amount.toLocaleString('it-IT', {minimumFractionDigits: 2, maximumFractionDigits: 20}) : 'importo non disponibile'}`
}
export function planResourceLabel(resource) {
  return `${resource.name}${resource.amount !== undefined ? `: ${resource.amount}` : ''}${resource.unit ? ` (${resource.unit})` : ''}`
}
export const renewalsGetPlanTool = {
  name: 'renewals_get_plan', moduleId: 'facile.renewals', credential: 'crm',
  requiresPrincipal: true, capabilityId: 'facile.renewals.read', mode: 'read', risk: 'low', terminal: true, stateful: false,
  definition: {type: 'function', function: {
    name: 'renewals_get_plan',
    description: 'Restituisce il dettaglio verificato di UN piano base Rinnovi/CRM identificato da plan: ID stabile o nome esatto normalizzato. Usalo per dettagli, cosa comprende, risorse o quanto costa uno specifico piano. Dopo una ricerca o lista usa il nome o ID del piano richiesto; se il risultato precedente è un singolo piano, per "quanto costa?" usa il suo ID nello snapshot. I nomi duplicati richiedono chiarimento, mai scegliere il primo. Restituisce risorse compatte e prezzi per versione di listino: nessun prezzo unico applicabile al cliente è dedotto. Un prezzo mancante resta non disponibile. Solo piani base, esclusi addon. Non cerca o elenca piani, non confronta due piani, non calcola più economico/conveniente/migliore, maggior numero di risorse, ranking o aggregazioni: capacità non migrate. Nessuna modifica a dati.',
    parameters: {type: 'object', required: ['plan'], additionalProperties: false,
      properties: {plan: {type: 'string', description: 'ID del piano nello snapshot oppure nome esatto non vuoto del piano base.'}}},
  }},
  async execute(args) {
    const data = await getRenewalsPlan(args)
    const reply = data.type === 'clarification'
      ? data.code === 'NOT_FOUND' ? `Piano base «${data.plan}» non trovato nel catalogo. Specifica un ID o un nome esatto; gli addon non sono inclusi.`
        : `Il nome «${data.plan}» identifica ${data.total} piani base. Specifica l'ID:\n${data.candidates.map(item => `- ${item.name}${item.supplier?.name ? ` · ${item.supplier.name}` : ''} · ${item.id || 'ID non disponibile'}`).join('\n')}`
      : [`Piano ${data.name}`, data.supplier ? `Fornitore: ${data.supplier.name}` : null,
        data.description || null, data.durationMonths !== undefined ? `Durata: ${data.durationMonths} mesi.` : null,
        data.resources.length ? `Risorse:\n${data.resources.map(item => `- ${planResourceLabel(item)}`).join('\n')}` : 'Nessuna risorsa riportata nel catalogo.',
        data.serviceTypesIn.length ? `Tipi di servizio in ingresso: ${data.serviceTypesIn.map(item => item.name).join(', ')}.` : null,
        data.serviceTypesOut.length ? `Tipi di servizio in uscita: ${data.serviceTypesOut.map(item => item.name).join(', ')}.` : null,
        data.pricing.missing ? 'Prezzo non disponibile nel catalogo.' : 'Prezzi del catalogo per versione di listino:',
        data.pricing.entries.length > 1 ? 'Sono presenti più voci per listino/versione; non è determinato un prezzo unico applicabile.' : null,
        ...data.pricing.entries.map(item => `- ${planPriceLabel(item)}`)].filter(Boolean).join('\n')
    return {ok: true, moduleId: 'facile.renewals', reply, data, modelContent: data}
  },
}
