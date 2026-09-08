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

if (!crmToken || !specialkToken) {
  console.error('CRM_TOKEN e SPECIALK_CMS_TOKEN sono obbligatori per la verifica live.')
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
  ['R15', 'Mostrami gli add-on che hanno un prezzo nel 2026.', /add-on|prezz/i],
  ['R16', 'Quali servizi sono scaduti da più di 30 giorni?', /scadut|30/i],
  ['R17', 'Quali servizi hanno scadenza fornitore diversa dalla nostra?', /scadenz|fornitor/i],
  ['R18', 'Quali fornitori hanno servizi sia nel 2026 sia nel 2027?', /valori distinti/i],
  ['R19', 'Raggruppa i servizi per fornitore e mostrami i primi cinque.', /servizi distinti/i],
  ['R20', 'Qual è il servizio che ha esaurito più volte lo spazio, escludendo Zilio Group?', /storico|ricorren|non.*dispon|spazio/i],
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
]

const cases = [
  ...renewals.map(([id, message, replyPattern]) => ({
    id, message, replyPattern, section: 'renewals', path: '/renewals',
  })),
  ...support.map(([id, message, replyPattern]) => ({
    id, message, replyPattern, section: 'sendinitaly-support', path: '/sendinitaly/support',
  })),
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

const results = []
for (let index = 0; index < cases.length; index += 2) {
  results.push(...await Promise.all(cases.slice(index, index + 2).map(execute)))
}

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.id} ${result.ms}ms ${result.intent || '-'} ${result.type || '-'} :: ${result.reply}`)
  for (const failure of result.failures) console.log(`  - ${failure}`)
}

const passed = results.filter(result => result.ok).length
const average = Math.round(results.reduce((sum, result) => sum + result.ms, 0) / results.length)
console.log(`\nRisultato: ${passed}/${results.length} superate, latenza media ${average}ms.`)
process.exitCode = passed === results.length ? 0 : 1
