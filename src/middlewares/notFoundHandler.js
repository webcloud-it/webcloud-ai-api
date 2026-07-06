export function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: 'Endpoint non trovato',
  })
}
