import renewalsModule from './facile/renewals/index.js'
import webcamgoModule from './facile/webcamgo/index.js'
import sendInItalyModule from './facile/sendinitaly/index.js'
import businessHoursModule from './facile/businesshours/index.js'

const modules = [renewalsModule, webcamgoModule, sendInItalyModule, businessHoursModule]

export function getRegisteredModules() {
  return modules
}

export function getModuleById(moduleId) {
  return modules.find(item => item.id === moduleId) || null
}

export function getModuleRoutePrefix(module) {
  return module.routePrefix || module.id.replaceAll('.', '/')
}
