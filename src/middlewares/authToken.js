export function authToken(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'Authorization Bearer token mancante',
    })
  }

  req.auth = {
    token,
  }

  next()
}
