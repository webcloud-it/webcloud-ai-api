import 'dotenv/config'
import {config as loadEnv} from 'dotenv'
import {fileURLToPath} from 'node:url'

if (!process.env.SPECIALK_CMS_TOKEN) {
  loadEnv({
    path: process.env.SPECIALK_ENV_FILE || fileURLToPath(new URL('../../specialk-api/.env', import.meta.url)),
    quiet: true,
  })
}

const API_URL = process.env.WEBCLOUD_AI_EVAL_URL || 'https://ai-api.webcloud.cloud/api/chat'
const crmToken = process.env.CRM_TOKEN
const specialkToken = process.env.SPECIALK_CMS_TOKEN
const webcamgoToken = process.env.WEBCAMGO_CONTROL_API_KEY
const requestedIds = new Set(
  String(process.env.EVAL_CASE_IDS || '')
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(Boolean)
)
const includeCrossDomain = process.env.EVAL_INCLUDE_CROSS === 'true' ||
  [...requestedIds].some(id => id.startsWith('M'))

if (!crmToken || !specialkToken || (includeCrossDomain && !webcamgoToken)) {
  console.error('Mancano una o più credenziali richieste per la verifica live selezionata.')
  process.exit(2)
}

const renewals = [
  ['R01', 'Quanti fornitori abbiamo?', /fornitor/i],
  ['R02', 'Quali fornitori hanno più servizi in scadenza nel 2027?', /servizi distinti/i],
  ['R03', 'Quanti servizi scadono a dicembre 2026?', /servizi distinti/i],
  ['R04', 'Quali domini scadono a settembre 2026?', /domini?|settembre|09\/2026/i],
  ['R05', 'Mostrami i servizi marcati come non rinnovare.', /non rinnov/i],
  ['R06', 'Mostrami i servizi da trasferire.', /trasfer/i],
  ['R07', 'Quali servizi di Zilio Group sono sia da non rinnovare sia da trasferire?', /Zilio|nessun/i],
  ['R08', 'Quali clienti hanno almeno 5 servizi in scadenza nel 2027?', /client|grupp/i],
  ['R09', 'Quali gruppi hanno più servizi con spazio esaurito?', /grupp|spazio/i],
  ['R10', 'Quali servizi hanno lo spazio occupato oltre il 90%?', /90|spazio/i],
  ['R11', 'Quanti domini non collegati a Plesk scadono nel 2027?', /domini?|Plesk/i],
  ['R12', 'Quali piani usa il fornitore Aruba?', /Aruba|pian/i],
  ['R13', 'Mostrami i piani del fornitore MisterDomain.', /MisterDomain|pian/i],
  ['R14', 'Quali servizi hanno prezzi mancanti?', /prezz/i],
  ['R15', 'Mostrami gli add-on che hanno un prezzo nel 2026.', /add-on|prezz/i, body => body.data?.plan?.filters?.some(filter => filter.field === 'plan.kind' && filter.value === 'addon')],
  ['R16', 'Quali servizi sono scaduti da più di 30 giorni?', /scadut|30/i],
  ['R17', 'Quali servizi hanno scadenza fornitore diversa dalla nostra?', /scadenz|fornitor/i],
  ['R18', 'Quali fornitori hanno servizi sia nel 2026 sia nel 2027?', /valori distinti/i],
  ['R19', 'Raggruppa i servizi per fornitore e mostrami i primi cinque.', /servizi distinti/i],
  ['R20', 'Qual è il servizio che ha esaurito più volte lo spazio, escludendo Zilio Group?', /storico|ricorren|non.*dispon|spazio/i],
  ['R21', 'Fammi la classifica dei primi tre fornitori per numero di servizi.', /servizi distinti/i],
  ['R22', 'Chi gestisce più servizi con rinnovo nel 2026?', /fornitor|servizi distinti/i],
  ['R23', 'Escludendo Aruba, quali sono i due fornitori con più servizi?', /servizi distinti/i],
  ['R24', 'Mostrami i clienti che hanno servizi segnati da non rinnovare.', /non rinnov/i],
  ['R25', 'Conta le sottoscrizioni del fornitore MisterDomain che scadono nel 2027.', /sottoscrizion|totale/i],
  ['R26', 'Quali gruppi hanno il maggior numero di servizi?', /grupp|servizi distinti/i],
  ['R27', 'Elenca i servizi che scadono a gennaio 2027.', /gennaio|01\/2027/i],
  ['R28', 'Quanti servizi risultano senza prezzo?', /servizi|prezz/i, body => body.data?.query?.filters?.some(filter => filter.kind === 'missing-price') && !body.data.query.filters.some(filter => filter.kind === 'customer-or-group')],
  ['R29', 'Quali fornitori hanno meno servizi?', /fornitor|servizi distinti/i],
  ['R30', 'Raggruppa i servizi per tipo.', /tip|servizi distinti/i],
  ['R31', 'Mostrami i primi cinque servizi con spazio esaurito.', /spazio/i, body => body.data?.query?.filters?.some(filter => filter.kind === 'space-full') && !body.data.query.filters.some(filter => filter.kind === 'space-usage-gte')],
  ['R32', 'Quali domini in scadenza nel 2027 sono marcati non rinnovare?', /domini?|non rinnov/i],
  ['R33', 'Mostrami i dettagli del piano DomProf25.', /DomProf25/i, body => body.data?.plan?.filters?.some(filter => filter.field === 'name' && filter.operator === 'equals' && filter.value === 'DomProf25') && body.data?.total === 1 && body.data?.items?.[0]?.name === 'DomProf25'],
  ['R34', 'Quante sottoscrizioni di MisterDomain scadono nel 2027?', /sottoscrizion|totale/i],
  ['R35', 'Quali fornitori utilizzano piani senza prezzo?', /fornitor|prezz/i, body => body.data?.plan?.filters?.some(filter => filter.field === 'missingPricePlanCount' && filter.operator === 'gte' && filter.value === 1) && body.data?.items?.every(item => item.missingPricePlanCount > 0)],
]

const support = [
  ['T01', 'Quanti ticket di assistenza sono aperti?', /ticket/i],
  ['T02', 'Elenca gli ultimi ticket di assistenza aperti.', /ticket|#\d+/i],
  ['T03', 'Raggruppa i ticket aperti per categoria.', /categor/i],
  ['T04', 'Raggruppa i ticket per stato.', /stato/i],
  ['T05', 'Raggruppa i ticket aperti per priorità.', /priorit/i],
  ['T06', 'Quali clienti hanno aperto più ticket?', /client|ticket/i],
  ['T07', 'Qual è il ticket aperto più vecchio?', /ticket|#\d+/i],
  ['T08', 'Quali ticket sono senza risposta?', /ticket|rispost/i],
  ['T09', 'Quali ticket sono senza risposta da più di due giorni?', /ticket|rispost|giorn/i],
  ['T10', 'Quali ticket sono stati escalati su ClickUp?', /ClickUp|escalat/i],
  ['T11', 'Mostrami il dettaglio del ticket 25004.', /25004/i],
  ['T12', 'Mostrami la conversazione del ticket 25004.', /25004/i],
  ['T13', 'Qual è l’ultima risposta nel ticket 25004?', /25004|rispost/i],
  ['T14', 'Quanti ticket hanno priorità alta?', /ticket|priorit/i],
  ['T15', 'Quanti ticket risultano chiusi?', /ticket|chius/i],
  ['T16', 'Confronta i primi due clienti per numero di ticket.', /client|ticket|prim/i],
  ['T17', 'Quanti ticket sono da gestire?', /ticket/i],
  ['T18', 'Chi ha mandato l’ultimo ticket?', /ultimo ticket.*aperto da/i],
  ['T19', 'Chi ha risolto il ticket 25003?', /25003.*chius|25003.*risolt/i],
  ['T20', 'Chi ha risolto il ticket 25004?', /non risulta chiuso/i],
  ['T21', 'Come va risolto il ticket 25004?', /analisi|piano consigliato|bozza di risposta/i],
  ['T22', 'Prepara una risposta per il ticket 25004.', /bozza di risposta|bozza proposta/i],
  ['T23', 'Prepara e invia una risposta per il ticket 25004.', /confermo|sto per inviare/i],
  ['T24', 'Chi ha scritto l’ultima risposta nel ticket 25004?', /ultima risposta.*scritta da/i, body => body.intent === 'sendinitaly-support-ticket-actor' && body.data?.articles?.length <= 1],
  ['T25', 'Mostrami le info del ticket 25004.', /25004/i],
  ['T26', 'Fammi un quadro della coda assistenza da gestire.', /ticket/i],
  ['T27', 'Quanti ticket nuovi ci sono?', /ticket|new/i],
  ['T28', 'Ci sono ticket in attesa?', /ticket|pending|attesa/i],
  ['T29', 'Quali categorie raccolgono più ticket aperti?', /categor/i, body => body.data?.analysis?.dimension === 'category'],
  ['T30', 'Classifica i clienti per ticket non chiusi.', /client|ticket/i, body => body.data?.analysis?.dimension === 'customerName' && body.data?.filters?.state === 'active'],
  ['T31', 'Quali richieste aspettano una risposta da oltre 24 ore?', /ticket|rispost|24 ore/i, body => body.data?.filters?.unanswered === true && body.data?.filters?.state === 'active'],
  ['T32', 'Fammi vedere gli ultimi tre ticket ricevuti.', /ticket|#\d+/i, body => body.data?.items?.length <= 3],
  ['T33', 'Riassumi il ticket numero 25004.', /25004/i, body => String(body.data?.ticket?.number) === '25004'],
  ['T34', 'Cosa ha scritto per ultimo il cliente nel ticket 25004?', /25004|Customer|cliente/i, body => body.data?.articles?.length === 1 && /customer|cliente/i.test(body.data.articles[0]?.sender || '')],
  ['T35', 'Nel ticket 25004 ha già risposto un operatore?', /25004|Agent|operatore/i, body => /^(?:s[iì]|no)\./i.test(body.reply || '')],
  ['T36', 'Qual è la categoria più frequente nei ticket?', /categor/i, body => body.data?.analysis?.dimension === 'category'],
  ['T37', 'Elenca i ticket collegati a ClickUp.', /ClickUp/i],
  ['T38', 'Mostrami i ticket aperti con priorità minima.', /ticket|priorit/i, body => body.data?.filters?.priority === 'minimum'],
  ['T39', 'Scrivi una bozza per il ticket 25004 senza inviarla.', /bozza|piano consigliato/i],
  ['T40', 'Prepara l’invio della risposta al ticket 25004.', /confermo|sto per inviare|bozza/i, body => body.data?.type === 'action-proposal'],
]

const sendInItaly = [
  ['S01', 'Quale cliente Send in Italy ha creato più campagne?', /campagne/i],
  ['S02', 'Elenca i clienti Send in Italy con almeno 100 contatti e più di 5 campagne.', /client|utent|campagne/i],
  ['S03', 'Raggruppa gli utenti Send in Italy per piano e mostrami la media dei contatti.', /piano[\s\S]*(?:avg contacts|media contatti)/i],
  ['S04', 'Confronta i primi due clienti Send in Italy per campagne e contatti.', /Confronto verificato[\s\S]*Differenze/i],
  ['S05', 'Quanti clienti Send in Italy hanno almeno una campagna?', /utenti Send in Italy/i],
  ['S06', 'Quali utenti Send in Italy hanno il piano SendInItalyFree?', /SendInItalyFree|non ho trovato/i],
  ['S07', 'Quali sono i tre utenti Send in Italy con più automazioni?', /automazioni/i],
  ['S08', 'Qual è il tasso di apertura Send in Italy negli ultimi 30 giorni?', /tasso di apertura/i],
  ['S09', 'Mostrami le campagne Send in Italy in coda.', /campagne/i],
  ['S10', 'Controlla lo stato DNS di Webcloud su Send in Italy.', /DNS|domini mittente/i],
  ['S11', 'Quali utenti Send in Italy hanno più contatti?', /contatti/i],
  ['S12', 'Confronta i tre clienti Send in Italy con più campagne usando anche i contatti.', /campagne[\s\S]*contatti|contatti[\s\S]*campagne/i, body => body.data?.plan?.limit === 3 && body.data?.items?.length === 3],
  ['S13', 'Calcola la media delle campagne per ogni piano Send in Italy.', /piano[\s\S]*(?:avg campaigns|media campagne)/i, body => body.data?.plan?.groupBy?.includes('plan') && !body.data.plan.filters?.some(filter => filter.field === 'plan')],
  ['S14', 'Quali utenti Send in Italy non sono collegati al CRM?', /CRM|utenti Send in Italy/i, body => body.data?.plan?.filters?.some(filter => filter.field === 'crmLinked' && filter.operator === 'falsey')],
  ['S15', 'Quanti utenti Send in Italy hanno almeno una automazione?', /utenti Send in Italy|automazioni/i],
  ['S16', 'Quali clienti Send in Italy hanno più liste?', /liste/i],
  ['S17', 'Mostrami i clienti Send in Italy con più mittenti.', /mittenti/i],
  ['S18', 'Qual è il tasso di click Send in Italy negli ultimi 30 giorni?', /tasso di click/i],
  ['S19', 'Mostrami le ultime campagne Send in Italy inviate.', /campagne/i],
  ['S20', 'Mostrami i dettagli dell’utente Send in Italy Webcloud.', /Webcloud/i, body => body.data?.type === 'sendinitaly-user-detail'],
]

const crossDomain = [
  ['M01', 'Quante webcam sono offline e quanti ticket sono da gestire?', /webcam[\s\S]*ticket|ticket[\s\S]*webcam/i],
  ['M02', 'Mostrami le webcam con stream offline e i cinque fornitori con più servizi in scadenza nel 2027.', /webcam[\s\S]*fornitor|fornitor[\s\S]*webcam/i],
]

const cases = [
  ...renewals.map(([id, message, replyPattern, validate]) => ({
    id, message, replyPattern, validate, section: 'renewals', path: '/renewals',
  })),
  ...support.map(([id, message, replyPattern, validate]) => ({
    id, message, replyPattern, validate, section: 'sendinitaly-support', path: '/sendinitaly/support',
  })),
  ...sendInItaly.map(([id, message, replyPattern, validate]) => ({
    id, message, replyPattern, validate, section: 'sendinitaly-users', path: '/sendinitaly/users',
  })),
  ...(includeCrossDomain
    ? crossDomain.map(([id, message, replyPattern]) => ({
        id, message, replyPattern, section: 'home', path: '/',
      }))
    : []),
]

const forbidden = /(?:non posso accedere|servizio non disponibile|non disponibile al momento|errore interno|riprova più tardi)/i

async function execute(item) {
  const startedAt = Date.now()
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${crmToken}`,
      'x-webcloud-credential-crm': crmToken,
      'x-webcloud-credential-specialk': specialkToken,
      ...(webcamgoToken ? {'x-webcloud-credential-webcamgo': webcamgoToken} : {}),
    },
    body: JSON.stringify({
      moduleId: 'facile',
      message: item.message,
      history: [],
      context: {app: 'facile', section: item.section, path: item.path},
    }),
  })
  const body = await response.json().catch(() => ({}))
  const reply = String(body.reply || body.message || '')
  const failures = []

  if (!response.ok || body.ok === false) failures.push(`HTTP ${response.status}`)
  if (!reply) failures.push('risposta vuota')
  if (forbidden.test(reply)) failures.push('fallback/errore applicativo')
  if (!item.replyPattern.test(reply)) failures.push(`contenuto inatteso: ${reply.slice(0, 120)}`)
  if (item.validate && !item.validate(body)) failures.push('struttura o filtri verificati non coerenti con la richiesta')

  return {
    id: item.id,
    ok: failures.length === 0,
    ms: Date.now() - startedAt,
    intent: body.intent || null,
    type: body.data?.type || null,
    source: body.source || null,
    failures,
    reply: reply.replace(/\s+/g, ' ').slice(0, 180),
  }
}

const selectedCases = requestedIds.size
  ? cases.filter(item => requestedIds.has(item.id.toUpperCase()))
  : cases

if (!selectedCases.length) {
  console.error('Nessun caso corrisponde a EVAL_CASE_IDS.')
  process.exit(2)
}

const results = []
for (let index = 0; index < selectedCases.length; index += 2) {
  results.push(...await Promise.all(selectedCases.slice(index, index + 2).map(execute)))
}

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.id} ${result.ms}ms ${result.intent || '-'} ${result.type || '-'} ${result.source || '-'} :: ${result.reply}`)
  for (const failure of result.failures) console.log(`  - ${failure}`)
}

const passed = results.filter(result => result.ok).length
const average = Math.round(results.reduce((sum, result) => sum + result.ms, 0) / results.length)
console.log(`\nRisultato: ${passed}/${results.length} superate, latenza media ${average}ms.`)
process.exitCode = passed === results.length ? 0 : 1
