import {httpError} from '../../../utils/httpError.js'
import {handleSendInItalyChat} from './chat.js'
import {getCampaigns, getCampaignStats, getUsers} from './service.js'

export async function summary(req, res) {
  const [campaigns, users] = await Promise.all([
    getCampaigns({token: req.auth.token, limit: 5}),
    getUsers({token: req.auth.token, limit: 5}),
  ])

  res.json({campaigns: campaigns.meta || {}, users: users.meta || {}})
}

export async function search(req, res) {
  const q = String(req.query?.q || '').trim()
  if (q.length < 2) throw httpError(400, 'Parametro q obbligatorio, minimo 2 caratteri')

  const [campaigns, users] = await Promise.all([
    getCampaigns({token: req.auth.token, search: q}),
    getUsers({token: req.auth.token, search: q}),
  ])

  res.json({query: q, campaigns, users})
}

export async function chatContext(req, res) {
  const stats = await getCampaignStats({token: req.auth.token, mode: 'last_30_days'})
  res.json(stats)
}

export async function chat(req, res) {
  const message = String(req.body?.message || '').trim()
  if (message.length < 2) throw httpError(400, 'message obbligatorio, minimo 2 caratteri')

  const startedAt = Date.now()
  const result = await handleSendInItalyChat({
    message,
    token: req.auth.token,
    context: req.body?.context || {},
  })

  res.json({
    ...result,
    meta: {...result.meta, timings: {totalMs: Date.now() - startedAt}},
  })
}
