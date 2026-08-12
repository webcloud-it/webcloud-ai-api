import express from 'express'

import {getChatFeedback, recordChatFeedback, updateChatFeedback} from '../core/observability/chatFeedback.js'
import {asyncHandler} from '../utils/asyncHandler.js'

const router = express.Router()

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const feedback = await recordChatFeedback(req.body, req.auth?.principal)
    res.status(201).json({ok: true, feedback: {id: feedback.id, at: feedback.at}})
  })
)

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const feedback = await getChatFeedback(req.query)

    if (req.query.format === 'jsonl') {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="chat-feedback-${new Date().toISOString().slice(0, 10)}.jsonl"`)
      return res.send(feedback.map(entry => JSON.stringify(entry)).join('\n'))
    }

    const negative = feedback.filter(entry => entry.rating === 'negative')
    return res.json({
      ok: true,
      total: feedback.length,
      summary: {
        positive: feedback.length - negative.length,
        negative: negative.length,
        byReason: Object.fromEntries(
          [...new Set(negative.map(entry => entry.reason))].map(reason => [
            reason,
            negative.filter(entry => entry.reason === reason).length,
          ])
        ),
      },
      feedback,
    })
  })
)

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const feedback = await updateChatFeedback(req.params.id, req.body, req.auth?.principal)
    res.json({ok: true, feedback})
  })
)

export default router
