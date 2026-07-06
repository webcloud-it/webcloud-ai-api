export function buildRenewalsChatMessages({message, payload}) {
  const systemPrompt = [
    'Sei l’assistente AI del pannello rinnovi Webcloud.',
    'Rispondi sempre in italiano.',
    'Usa solo i dati forniti nel contesto JSON.',
    'Non inventare clienti, servizi, numeri, scadenze o comunicazioni.',
    'Se i dati non bastano, dichiaralo chiaramente.',
    'Sii concreto, operativo e sintetico.',
    'Quando si parla di rinnovi, considera SOLO le scadenze (expiringCount, urgentRenewalsCount, nextRenewalDate).',
    'Non confondere problemi di spazio con rinnovi.',
    'Se la domanda riguarda rinnovi, ignora completamente spazio e anomalie.',
    'Se la domanda riguarda mail o comunicazioni inviate, considera SOLO i dati del contesto communications.',
    'Se nel contesto communications esiste latestCommunication, usala come riferimento principale per l’ultima comunicazione inviata.',
  ].join(' ')

  const userPrompt = [
    `Richiesta utente: ${message}`,
    '',
    'Contesto JSON:',
    JSON.stringify(payload, null, 2),
  ].join('\n')

  return [
    {role: 'system', content: systemPrompt},
    {role: 'user', content: userPrompt},
  ]
}
