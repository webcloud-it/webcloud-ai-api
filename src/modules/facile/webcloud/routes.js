import {httpError} from '../../../utils/httpError.js'
import {handleWebcloudChat} from './chat.js'

export async function chat(req, res) {
  const message = String(req.body?.message || '').trim()
  if (message.length < 2) throw httpError(400, 'message obbligatorio, minimo 2 caratteri')
  const startedAt = Date.now()
  const result = await handleWebcloudChat({message, credentials: req.auth.credentials})
  res.json({...result, meta: {...result.meta, timings: {totalMs: Date.now() - startedAt}}})
}
