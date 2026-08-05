function normalizeUndoMessage(message = '') {
  return String(message || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[.!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
}

const GENERIC_UNDO_PATTERNS = [
  /^(?:annulla|annullo|undo|revert|ripristina|ripristino|revoca|revoco)$/i,
  /^(?:annulla|annullo|cancella|revoca|ripristina)\s+(?:l['’]?ultima|la scorsa|la precedente)\s+(?:operazione|azione|modifica)$/i,
  /^(?:annulla|annullo|cancella|revoca|ripristina)\s+(?:questa|la)\s+(?:operazione|azione|modifica)$/i,
  /^(?:torna|torniamo|vai)\s+indietro$/i,
  /^(?:fai|facciamo)\s+(?:un\s+passo\s+indietro|marcia\s+indietro)$/i,
  /^(?:rimetti|riporta|ripristina)\s+(?:tutto\s+)?(?:com['’]era|come\s+prima|allo\s+stato\s+precedente)$/i,
]

export function isGenericOperationUndoRequest(message = '') {
  const normalized = normalizeUndoMessage(message)

  return Boolean(
    normalized && GENERIC_UNDO_PATTERNS.some(pattern => pattern.test(normalized))
  )
}

export function pickLatestCompletedOperation(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate, index) => ({...candidate, __index: index}))
    .filter(candidate => {
      const completedAt = Number(candidate?.context?.completedAt)
      return candidate?.kind && candidate?.context && Number.isFinite(completedAt)
    })
    .sort((first, second) => {
      const byDate =
        Number(second.context.completedAt) - Number(first.context.completedAt)

      return byDate || second.__index - first.__index
    })
    .map(({__index, ...candidate}) => candidate)[0] || null
}
