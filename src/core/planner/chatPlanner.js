function normalizeMessage(message = '') {
  return String(message || '')
    .trim()
    .toLowerCase()
}

function isOnlyGreeting(text) {
  return /^(ciao|salve|buongiorno|buonasera|hey|ciao!)$/i.test(text)
}

function hasGreeting(text) {
  return /^(ciao|salve|buongiorno|buonasera|hey)[,!.\s]/i.test(text)
}

function wantsSummary(text) {
  return /(riepilogo|situazione|panoramica|overview|come siamo messi|stato generale)/i.test(text)
}

function wantsSearch(text) {
  return /(cerca|trova|cerco|servizio|cliente|gruppo)/i.test(text)
}

function wantsCritical(text) {
  return /(criticità|criticit|critici|anomali|anomalie|problemi principali|urgenti)/i.test(text)
}

function wantsTodo(text) {
  return /(cose da fare|todo|da fare|attività|azioni da fare|priorità)/i.test(text)
}

export function planChatRequest({message, context = {}}) {
  const text = normalizeMessage(message)

  if (!text || text.length < 2) {
    return {
      type: 'invalid',
      reason: 'empty-message',
    }
  }

  if (isOnlyGreeting(text)) {
    return {
      type: 'direct',
      intent: 'greeting',
      reply:
        'Ciao, sono l’assistente AI di Webcloud. Posso aiutarti ad analizzare rinnovi, servizi, clienti, scadenze e criticità.',
    }
  }

  if (wantsSearch(text)) {
    return {
      type: 'tool',
      intent: 'search',
      useLlm: false,
    }
  }

  if (wantsCritical(text)) {
    return {
      type: 'tool',
      intent: 'critical',
      useLlm: false,
    }
  }

  if (wantsTodo(text)) {
    return {
      type: 'tool',
      intent: 'todo',
      useLlm: false,
    }
  }

  if (wantsSummary(text) || hasGreeting(text)) {
    return {
      type: 'tool',
      intent: context.customerId ? 'customer-report' : context.groupId ? 'group-report' : 'summary',
      useLlm: false,
    }
  }

  return {
    type: 'llm',
    intent: 'freeform',
    useLlm: true,
  }
}
