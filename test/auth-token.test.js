import test from 'node:test'
import assert from 'node:assert/strict'

import {createAuthTokenMiddleware, validateCrmCredential} from '../src/middlewares/authToken.js'

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    },
  }
}

test('rifiuta richieste prive di bearer token', async () => {
  const middleware = createAuthTokenMiddleware()
  const response = responseRecorder()
  let continued = false

  await middleware({headers: {}, body: {}}, response, () => { continued = true })

  assert.equal(response.statusCode, 401)
  assert.equal(continued, false)
})

test('valida la sessione CRM prima di abilitare i privilegi server-side', async () => {
  let receivedToken = null
  const middleware = createAuthTokenMiddleware({
    validateCrmToken: async token => {
      receivedToken = token
      return {id: 'user-1', source: 'crm'}
    },
  })
  const request = {
    headers: {authorization: 'Bearer primary', 'x-webcloud-credential-crm': 'crm-user-token'},
    body: {moduleId: 'facile'},
  }
  const response = responseRecorder()
  let continued = false

  await middleware(request, response, () => { continued = true })

  assert.equal(receivedToken, 'crm-user-token')
  assert.equal(request.auth.principal.id, 'user-1')
  assert.equal(request.auth.credentials.crm, 'crm-user-token')
  assert.equal(continued, true)
})

test('valida utenti Directus senza richiedere la lettura del nome ruolo', async () => {
  let requestedUrl = null
  const principal = await validateCrmCredential('user-token-with-string-role', {
    baseUrl: 'https://crm.example.test',
    fetchImpl: async url => {
      requestedUrl = url
      return {
        ok: true,
        json: async () => ({
          data: {id: 'user-2', status: 'active', role: 'role-operator'},
        }),
      }
    },
  })

  assert.match(requestedUrl, /fields=id,status,role$/)
  assert.equal(principal.id, 'user-2')
  assert.equal(principal.roleId, 'role-operator')
  assert.equal(principal.roleName, null)
})

test('rifiuta una credenziale CRM non valida', async () => {
  const middleware = createAuthTokenMiddleware({validateCrmToken: async () => null})
  const response = responseRecorder()

  await middleware(
    {headers: {authorization: 'Bearer invalid'}, body: {moduleId: 'facile.renewals'}},
    response,
    () => assert.fail('non deve continuare')
  )

  assert.equal(response.statusCode, 401)
  assert.match(response.payload.error, /non valida|scaduta/i)
})

test('non forza il CRM per un modulo che usa una credenziale dedicata', async () => {
  let validationCalls = 0
  const middleware = createAuthTokenMiddleware({
    validateCrmToken: async () => {
      validationCalls += 1
      return null
    },
  })
  const request = {
    headers: {authorization: 'Bearer webcam-token', 'x-webcloud-credential-webcamgo': 'webcam-token'},
    body: {moduleId: 'facile.webcamgo'},
  }
  const response = responseRecorder()
  let continued = false

  await middleware(request, response, () => { continued = true })

  assert.equal(validationCalls, 0)
  assert.equal(request.auth.credentials.webcamgo, 'webcam-token')
  assert.equal(continued, true)
})
