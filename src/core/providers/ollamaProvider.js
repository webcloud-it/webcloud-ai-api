import fetch from 'node-fetch'

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

export async function callOllamaChat({messages, timeoutMs = null, format = null, options = null}) {
  const model = process.env.OLLAMA_CHAT_MODEL || 'mistral:latest'
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'
  const resolvedTimeoutMs = Number(timeoutMs || process.env.OLLAMA_TIMEOUT_MS || 20000)

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, resolvedTimeoutMs)

  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        messages,
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

    const json = await res.json()
    return json?.message?.content?.trim() || 'Nessuna risposta generata.'
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
