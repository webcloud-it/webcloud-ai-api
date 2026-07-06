import express from 'express'
import {getModuleById} from '../modules/registry.js'
import {asyncHandler} from '../utils/asyncHandler.js'

const router = express.Router()

router.post(
  '/',
  asyncHandler(async (req, res, next) => {
    const moduleId = req.body?.moduleId || 'facile.renewals'
    const module = getModuleById(moduleId)

    if (!module?.routes?.chat) {
      return res.status(404).json({
        ok: false,
        error: `Modulo AI non trovato o non conversazionale: ${moduleId}`,
      })
    }

    return module.routes.chat(req, res, next)
  })
)

export default router
