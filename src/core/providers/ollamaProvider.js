import fetch from 'node-fetch'

export async function callOllamaChat({messages}) {
  const model = process.env.OLLAMA_CHAT_MODEL || process.env.OPENAI_CHAT_MODEL || 'mistral'
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages,
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Ollama error: ${errText}`)
  }

  const json = await res.json()
  return json?.message?.content?.trim() || 'Nessuna risposta generata.'
}
