import renewalsModule from './facile/renewals/index.js'
import webcamgoModule from './facile/webcamgo/index.js'
import sendInItalyModule from './facile/sendinitaly/index.js'
import businessHoursModule from './facile/businesshours/index.js'
import asiagoModule from './facile/asiago/index.js'
import webcloudModule from './facile/webcloud/index.js'
import {assertToolRegistration} from '../core/tools/toolContract.js'

const modules = [renewalsModule, webcamgoModule, sendInItalyModule, businessHoursModule, asiagoModule, webcloudModule]

export function getRegisteredModules() {
  return modules
}

export function getModuleById(moduleId) {
  return modules.find(item => item.id === moduleId) || null
}

export function getModuleRoutePrefix(module) {
  return module.routePrefix || module.id.replaceAll('.', '/')
}


export function getRegisteredTools({credentials = {}, includeUnavailable = false} = {}) {
  return collectModuleTools(modules).filter(tool =>
    includeUnavailable || Boolean(credentials?.[tool.credential])
  )
}

export function collectModuleTools(registeredModules) {
  const names = new Set()
  return registeredModules.flatMap(module => {
    if (module.tools !== undefined && !Array.isArray(module.tools)) {
      throw new TypeError(`Registro tool non valido per ${module.id}: tools deve essere un array`)
    }
    return (module.tools || []).map(tool => {
      assertToolRegistration(tool, module.id)
      if (names.has(tool.name)) throw new TypeError(`Nome tool duplicato: ${tool.name}`)
      names.add(tool.name)
      return tool
    })
  })
}
