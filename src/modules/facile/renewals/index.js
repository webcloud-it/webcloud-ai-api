import * as routes from './routes.js'
import {renewalsTools} from './tools.js'

export default {
  id: 'facile.renewals',
  name: 'Facile Renewals',
  app: 'facile',
  module: 'renewals',
  routePrefix: 'facile/renewals',
  routes,
  tools: renewalsTools,
}
