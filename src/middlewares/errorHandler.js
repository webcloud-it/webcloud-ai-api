export function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || err.status || 500

  res.status(statusCode).json({
    ok: false,
    error: err.message || 'Errore interno del server',
  })
}
