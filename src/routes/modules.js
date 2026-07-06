import express from 'express'
import {getRegisteredModules, getModuleRoutePrefix} from '../modules/registry.js'
import {asyncHandler} from '../utils/asyncHandler.js'

const router = express.Router()

for (const module of getRegisteredModules()) {
  const prefix = getModuleRoutePrefix(module)

  if (module.routes?.summary) {
    router.get(`/${prefix}/summary`, asyncHandler(module.routes.summary))
  }

  if (module.routes?.todo) {
    router.get(`/${prefix}/todo`, asyncHandler(module.routes.todo))
  }

  if (module.routes?.customerReport) {
    router.get(`/${prefix}/customer-report`, asyncHandler(module.routes.customerReport))
  }

  if (module.routes?.groupReport) {
    router.get(`/${prefix}/group-report`, asyncHandler(module.routes.groupReport))
  }

  if (module.routes?.criticalServices) {
    router.get(`/${prefix}/critical-services`, asyncHandler(module.routes.criticalServices))
  }

  if (module.routes?.search) {
    router.get(`/${prefix}/search`, asyncHandler(module.routes.search))
  }

  if (module.routes?.chatContext) {
    router.get(`/${prefix}/chat-context`, asyncHandler(module.routes.chatContext))
  }
}

export default router
