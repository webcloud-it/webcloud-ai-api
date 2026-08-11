import test from 'node:test'
import assert from 'node:assert/strict'

import {errorHandler} from '../src/middlewares/errorHandler.js'
import {attachRequestId, getChatAuditSummary, recordChatAudit} from '../src/core/observability/chatAudit.js'

function responseRecorder() {
  return {
    statusValue: null,
    body: null,
    status(value) {
      this.statusValue = value
      return this
    },
    json(value) {
      this.body = value
      return this
    },
  }
}

test('hides upstream implementation details for server errors', () => {
  const res = responseRecorder()
  errorHandler(new Error('select * from secrets where token = raw'), {requestId: 'req-1'}, res)
  assert.equal(res.statusValue, 500)
  assert.match(res.body.error, /temporaneamente non disponibile/)
  assert.equal(JSON.stringify(res.body).includes('select *'), false)
  assert.equal(res.body.requestId, 'req-1')
})

test('keeps actionable validation messages for client errors', () => {
  const res = responseRecorder()
  const error = new Error('Parametro q obbligatorio')
  error.statusCode = 400
  errorHandler(error, {}, res)
  assert.equal(res.statusValue, 400)
  assert.equal(res.body.error, 'Parametro q obbligatorio')
})

test('sanitizes untrusted request identifiers', () => {
  const req = {headers: {'x-request-id': 'bad id\r\nforged'}}
  attachRequestId(req, {}, () => {})
  assert.match(req.requestId, /^[a-z0-9-]+$/i)
  assert.notEqual(req.requestId, 'bad id\r\nforged')
})

test('summarizes audit health without storing prompts', () => {
  recordChatAudit({requestId: 'summary-test', requestedModuleId: 'facile.webcloud', moduleId: 'facile.webcloud', intent: 'test', ok: false, durationMs: 6000})
  const summary = getChatAuditSummary({windowMinutes: 60, slowThresholdMs: 5000})
  assert.ok(summary.requests >= 1)
  assert.ok(summary.failures >= 1)
  assert.ok(summary.slowRequests >= 1)
  assert.equal(JSON.stringify(summary).includes('prompt'), false)
})
