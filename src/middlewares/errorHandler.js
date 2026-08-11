export function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || err.status || 500

  res.status(statusCode).json({
    ok: false,
    error:
      err.publicMessage ||
      (statusCode >= 500
        ? 'Il servizio richiesto è temporaneamente non disponibile. Riprova tra poco.'
        : err.message || 'Richiesta non valida'),
    ...(req.requestId ? {requestId: req.requestId} : {}),
  })
}
