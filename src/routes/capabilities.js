import express from 'express'
import {getCapabilityCatalog} from '../core/capabilities/catalog.js'

const router = express.Router()

router.get('/', (req, res) => {
  const includeUnavailable = req.query?.includeUnavailable === 'true'
  const capabilities = getCapabilityCatalog({
    credentials: req.auth.credentials,
    includeUnavailable,
  })

  res.json({
    ok: true,
    version: '1',
    app: req.query?.app || 'facile',
    capabilities,
  })
})

export default router

