import {httpError} from '../../../utils/httpError.js'
import {handleWebcamgoChat} from './chat.js'
import {
  buildWebcamDetailPayload,
  buildWebcamListPayload,
  buildWebcamSummaryPayload,
  parseListQuery,
  parseWebcamHistoryRequest,
  pickPreviousWebcamTarget,
} from './queries.js'
import {getWebcams, getWebcamStatusLogs} from './service.js'
import {handleWebcamgoOperation} from './operations.js'
import {getContextEntityTarget} from '../../../core/context/pageContext.js'
import {isOpenEntityRequest} from '../../../core/entities/entityResolver.js'
import {composeGroundedReply} from '../../../core/presentation/groundedReplyComposer.js'

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
  const normalizedMessage = String(message).trim()
  const identityOnly =
    isOpenEntityRequest(normalizedMessage) &&
    /\b(?:webcam|telecamera)\b/i.test(normalizedMessage) &&
    !/\b(?:snapshot|fotogramma|immagine|preset|ptz|riavvia|reboot|diagnostica|connettivit[aà]|stato|stream|router|mikrotik)\b/i.test(normalizedMessage)
  const includeDowntime = /\b(?:downtime|spegniment[oi]|pianificazion[ei]|riepilogo|riassunto|panoramica|stato generale)\b/i.test(normalizedMessage)
  const preliminaryListQuery = /\b(?:quali|elenca|elencami|lista|mostra|mostrami)\b/i.test(normalizedMessage)
    ? parseListQuery(normalizedMessage)
    : null
  const webcams = await getWebcams({
    token: req.auth.token,
    profile: identityOnly ? 'identity' : 'full',
    includeDowntime,
    searchTerm: preliminaryListQuery?.term || null,
  })
  const historyRequest = parseWebcamHistoryRequest(message)
  let statusLogs = []

  if (historyRequest?.type === 'outage-duration') {
    statusLogs = await getWebcamStatusLogs({
      token: req.auth.token,
      type: historyRequest.statusType,
      since: historyRequest.fetchSince,
    })
  } else if (historyRequest?.type === 'latest-offline') {
    const target =
      historyRequest.target ||
      getContextEntityTarget(context, 'webcam') ||
      pickPreviousWebcamTarget(history)
    const detail = target ? buildWebcamDetailPayload({webcams, target}) : null

    if (detail?.type === 'webcam-detail') {
      statusLogs = await getWebcamStatusLogs({
        token: req.auth.token,
        webcamId: detail.item.id,
        statusNot: 'online',
        limit: 100,
      })
    }
  }
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
    statusLogs,
    historyRequest,
  })

  const response = await composeGroundedReply({
    message: normalizedMessage,
    result: {
      ...result,
      meta: {
        ...(result.meta || {}),
        webcamsCount: webcams.length,
        timings: {
          dataLoadMs,
          totalMs: Date.now() - startedAt,
        },
      },
    },
  })

  res.json(response)
}
