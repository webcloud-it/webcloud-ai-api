import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

test('stores feedback and preserves resolved entries for regression history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'webcloud-ai-feedback-'))
  process.env.AI_FEEDBACK_STORAGE_PATH = join(directory, 'feedback.jsonl')
  process.env.AI_FEEDBACK_MAX_ENTRIES = '100'

  try {
    const {getChatFeedback, recordChatFeedback, updateChatFeedback} = await import(
      `../src/core/observability/chatFeedback.js?test=${Date.now()}`
    )
    const created = await recordChatFeedback(
      {
        rating: 'negative',
        reason: 'misunderstood',
        requestId: 'req-1',
        moduleId: 'facile.webcamgo',
        question: 'Apri le Melette, token=super-secret-value',
        answer: 'Ho trovato 70 webcam.',
        context: {
          app: 'facile',
          section: 'webcamgo',
          path: '/webcamgo/webcams/melette1',
          token: 'must-not-be-stored',
          activeEntity: {type: 'webcam', id: 'melette1', password: 'secret'},
        },
      },
      {id: 'user-1'}
    )

    assert.equal(created.status, 'open')
    assert.equal(created.context.token, undefined)
    assert.equal(created.context.activeEntity.password, undefined)
    assert.equal(created.question, 'Apri le Melette, token=[REDACTED]')
    assert.equal((await getChatFeedback()).length, 1)

    const resolved = await updateChatFeedback(
      created.id,
      {status: 'resolved', resolutionNote: 'Entity resolver aggiornato'},
      {id: 'admin-1'}
    )
    assert.equal(resolved.status, 'resolved')
    assert.equal((await getChatFeedback()).length, 0)
    assert.equal((await getChatFeedback({status: 'all'}))[0].resolutionNote, 'Entity resolver aggiornato')

    const lines = (await readFile(process.env.AI_FEEDBACK_STORAGE_PATH, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 2)
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})

test('requires a reason for negative feedback', async () => {
  const {recordChatFeedback} = await import('../src/core/observability/chatFeedback.js')
  await assert.rejects(() => recordChatFeedback({rating: 'negative'}), /motivo/i)
})
