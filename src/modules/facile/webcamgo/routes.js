import {httpError} from '../../../utils/httpError.js'
import {handleWebcamgoChat} from './chat.js'
import {
  buildWebcamListPayload,
  buildWebcamSummaryPayload,
  parseListQuery,
} from './queries.js'
import {getWebcams} from './service.js'
import {handleWebcamgoOperation} from './operations.js'

export async function summary(req, res) {
  const webcams = await getWebcams({token: req.auth.token})
  const payload = buildWebcamSummaryPayload(webcams)

  res.json(payload)
}

export async function search(req, res) {
  const q = String(req.query?.q || '').trim()

  if (q.length < 2) {
    throw httpError(400, 'Parametro q obbligatorio, minimo 2 caratteri')
  }

  const webcams = await getWebcams({token: req.auth.token})
  const query = parseListQuery(`cerca webcam "${q}"`)
  const payload = buildWebcamListPayload({webcams, query})

  res.json({
    totale: payload.totale,
    items: payload.items,
  })
}

export async function chatContext(req, res) {
  const webcams = await getWebcams({token: req.auth.token})

  res.json(buildWebcamSummaryPayload(webcams))
}

export async function chat(req, res) {
  const startedAt = Date.now()
  const {message, context = {}, history = []} = req.body || {}

  if (!message || String(message).trim().length < 2) {
    throw httpError(400, 'message obbligatorio, minimo 2 caratteri')
  }

  const dataLoadStartedAt = Date.now()
  const webcams = await getWebcams({token: req.auth.token})
  const dataLoadMs = Date.now() - dataLoadStartedAt

  const operationResult = await handleWebcamgoOperation({
    message: String(message).trim(),
    history: Array.isArray(history) ? history : [],
    webcams,
    token: req.auth.token,
    context,
  })

  const result = operationResult || handleWebcamgoChat({
    message: String(message).trim(),
    history: Array.isArray(history) ? history : [],
    webcams,
    context,
  })

  res.json({
    ...result,
    meta: {
      ...(result.meta || {}),
      webcamsCount: webcams.length,
      timings: {
        dataLoadMs,
        totalMs: Date.now() - startedAt,
      },
    },
  })
}
