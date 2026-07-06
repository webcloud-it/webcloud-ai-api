import renewalsModule from './facile/renewals/index.js'

const modules = [renewalsModule]

export function getRegisteredModules() {
  return modules
}

export function getModuleById(moduleId) {
  return modules.find(item => item.id === moduleId) || null
}

export function getModuleRoutePrefix(module) {
  return module.routePrefix || module.id.replaceAll('.', '/')
}
