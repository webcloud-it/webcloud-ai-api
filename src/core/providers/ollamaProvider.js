import fetch from 'node-fetch'
import {env} from '../../config/env.js'

export class OllamaProviderError extends Error {
  constructor(message, {status = null, details = null, cause = null} = {}) {
    super(message)
    this.name = 'OllamaProviderError'
    this.status = status
    this.details = details
    this.cause = cause
  }
}

function isConnectionError(error) {
  const code = error?.code || error?.cause?.code

  return ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT'].includes(code)
}

async function callOllamaApi({
  messages,
  timeoutMs = null,
  format = null,
  options = null,
  tools = null,
  fetchImpl = fetch,
}) {
  const model = env.ollamaChatModel
  const baseUrl = env.ollamaBaseUrl.replace(/\/$/, '')
  const resolvedTimeoutMs = Number(timeoutMs || env.ollamaTimeoutMs)

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, resolvedTimeoutMs)

  try {
    const res = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.ollamaApiKey ? {Authorization: `Bearer ${env.ollamaApiKey}`} : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        think: env.ollamaThink,
        keep_alive: env.ollamaKeepAlive,
        messages,
        ...(Array.isArray(tools) && tools.length ? {tools} : {}),
        ...(format ? {format} : {}),
        ...(options ? {options} : {}),
      }),
    })

    if (!res.ok) {
      const errText = await res.text()

      throw new OllamaProviderError(`Ollama ha risposto con errore ${res.status}`, {
        status: res.status,
        details: errText,
      })
    }

    return await res.json()
  } catch (error) {
    if (error instanceof OllamaProviderError) {
      throw error
    }

    if (error?.name === 'AbortError') {
      throw new OllamaProviderError(`Timeout Ollama dopo ${resolvedTimeoutMs}ms`, {
        cause: error,
      })
    }

    if (isConnectionError(error)) {
      throw new OllamaProviderError(
        'Ollama non è raggiungibile. Verifica che il servizio sia avviato.',
        {
          cause: error,
        }
      )
    }

    throw new OllamaProviderError('Errore durante la chiamata a Ollama', {
      cause: error,
    })
  } finally {
    clearTimeout(timeout)
  }
}

function durationNsToMs(value) {
  const ns = Number(value)
  return Number.isFinite(ns) ? Math.round(ns / 1_000_000) : null
}

function buildOllamaResponseMeta(json = {}) {
  return {
    model: json?.model || null,
    totalDurationMs: durationNsToMs(json?.total_duration),
    loadDurationMs: durationNsToMs(json?.load_duration),
    promptEvalCount: Number.isFinite(Number(json?.prompt_eval_count))
      ? Number(json.prompt_eval_count)
      : null,
    promptEvalDurationMs: durationNsToMs(json?.prompt_eval_duration),
    evalCount: Number.isFinite(Number(json?.eval_count)) ? Number(json.eval_count) : null,
    evalDurationMs: durationNsToMs(json?.eval_duration),
    doneReason: json?.done_reason || null,
  }
}

export async function callOllamaChatMessage({
  messages,
  timeoutMs = null,
  format = null,
  options = null,
  tools = null,
  fetchImpl = fetch,
}) {
  const json = await callOllamaApi({
    messages,
    timeoutMs,
    format,
    options,
    tools,
    fetchImpl,
  })

  const message = json?.message
  if (!message || typeof message !== 'object') {
    throw new OllamaProviderError('Ollama non ha restituito un messaggio valido')
  }

  return {
    ...message,
    _ollama: buildOllamaResponseMeta(json),
  }
}

export async function callOllamaChat({
  messages,
  timeoutMs = null,
  format = null,
  options = null,
  fetchImpl = fetch,
}) {
  const message = await callOllamaChatMessage({
    messages,
    timeoutMs,
    format,
    options,
    fetchImpl,
  })

  return String(message?.content || '').trim() || 'Nessuna risposta generata.'
}

export async function checkOllamaReadiness({
  fetchImpl = fetch,
  timeoutMs = 3000,
  model = env.ollamaChatModel,
} = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(`${env.ollamaBaseUrl.replace(/\/$/, '')}/api/tags`, {
      headers: {
        Accept: 'application/json',
        ...(env.ollamaApiKey ? {Authorization: `Bearer ${env.ollamaApiKey}`} : {}),
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      return {ok: false, model, reason: `http-${response.status}`}
    }

    const payload = await response.json()
    const availableModels = Array.isArray(payload?.models)
      ? payload.models.map(item => item?.name || item?.model).filter(Boolean)
      : []
    const modelAvailable = availableModels.includes(model)

    return {
      ok: modelAvailable,
      model,
      reason: modelAvailable ? null : 'model-not-installed',
    }
  } catch (error) {
    return {
      ok: false,
      model,
      reason: error?.name === 'AbortError' ? 'timeout' : 'unreachable',
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function callOllamaJson({messages, timeoutMs = null, options = {temperature: 0}} = {}) {
  const content = await callOllamaChat({
    messages,
    timeoutMs,
    format: 'json',
    options,
  })

  const jsonText = String(content || '').trim().match(/\{[\s\S]*\}/)?.[0]

  if (!jsonText) {
    throw new OllamaProviderError('Ollama non ha restituito un JSON valido')
  }

  try {
    return JSON.parse(jsonText)
  } catch (cause) {
    throw new OllamaProviderError('Ollama ha restituito JSON non valido', {cause})
  }
}
