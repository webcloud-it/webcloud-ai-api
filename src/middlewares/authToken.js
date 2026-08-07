export function authToken(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'Authorization Bearer token mancante',
    })
  }

  const credentials = {
    crm: readHeader(req, 'x-webcloud-credential-crm'),
    webcamgo: readHeader(req, 'x-webcloud-credential-webcamgo'),
    specialk: readHeader(req, 'x-webcloud-credential-specialk'),
    cmsAsiagoIt: readHeader(req, 'x-webcloud-credential-cms-asiago-it'),
  }

  // Backwards compatibility: the bearer token remains the credential used by
  // legacy, module-specific clients. Global clients provide named credentials.
  if (!credentials.crm && !credentials.webcamgo) {
    credentials.primary = token
  }

  req.auth = {token, credentials}

  next()
}

function readHeader(req, name) {
  const value = req.headers?.[name]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
