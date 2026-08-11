import {httpError} from '../../../utils/httpError.js'
import {handleAsiagoChat} from './chat.js'
import {getContents, getEvents, getMinisites} from './service.js'

export async function summary(req, res) {
  const [events, contents, minisites] = await Promise.all([
    getEvents({token: req.auth.token, upcoming: true, limit: 5}),
    getContents({token: req.auth.token, limit: 5}),
    getMinisites({token: req.auth.token, limit: 5}),
  ])
  res.json({events, contents, minisites})
}

export async function search(req, res) {
  const q = String(req.query?.q || '').trim()
  if (q.length < 2) throw httpError(400, 'Parametro q obbligatorio, minimo 2 caratteri')
  const [events, contents, minisites] = await Promise.all([
    getEvents({token: req.auth.token, search: q}),
    getContents({token: req.auth.token, search: q}),
    getMinisites({token: req.auth.token, search: q}),
  ])
  res.json({query: q, events, contents, minisites})
}

export async function chatContext(req, res) {
  const events = await getEvents({token: req.auth.token, upcoming: true, limit: 5})
  res.json({upcomingEvents: events})
}

export async function chat(req, res) {
  const message = String(req.body?.message || '').trim()
  if (message.length < 2) throw httpError(400, 'message obbligatorio, minimo 2 caratteri')
  const startedAt = Date.now()
  const result = await handleAsiagoChat({message, token: req.auth.token, credentials: req.auth.credentials})
  res.json({...result, meta: {...result.meta, timings: {totalMs: Date.now() - startedAt}}})
}
