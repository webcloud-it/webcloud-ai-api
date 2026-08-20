import cors from 'cors'
import express from 'express'

import {env} from './config/env.js'
import {buildInfo} from './config/build.js'
import {errorHandler} from './middlewares/errorHandler.js'
import {notFoundHandler} from './middlewares/notFoundHandler.js'
import chatRouter from './routes/chat.js'
import feedbackRouter from './routes/feedback.js'
import modulesRouter from './routes/modules.js'
import capabilitiesRouter from './routes/capabilities.js'
import {authToken} from './middlewares/authToken.js'
import {attachRequestId} from './core/observability/chatAudit.js'
import {checkOllamaReadiness} from './core/providers/ollamaProvider.js'
import {
  getAllServices,
  getServiceOptions,
  getSettings,
} from './modules/facile/renewals/service.js'
import {checkAnalyticalReadPlannerReadiness} from './modules/facile/renewals/readQueryPlanner.js'

const app = express()

app.use(
  cors({
    origin: env.corsOrigin,
  })
)

app.use(express.json({limit: '2mb'}))

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'webcloud-ai-api',
    env: env.nodeEnv,
    build: buildInfo,
  })
})

app.get('/ready', async (req, res) => {
  const ollama = await checkOllamaReadiness()
  const analyticalReadPlanner = checkAnalyticalReadPlannerReadiness()
  const ready = (!env.ollamaRequired || ollama.ok) && analyticalReadPlanner.ok

  res.status(ready ? 200 : 503).json({
    ok: ready,
    service: 'webcloud-ai-api',
    build: buildInfo,
    dependencies: {
      ollama: {...ollama, required: env.ollamaRequired},
      analyticalReadPlanner,
    },
  })
})

app.use('/api/chat', attachRequestId, authToken, chatRouter)
app.use('/api/feedback', authToken, feedbackRouter)
app.use('/api/capabilities', authToken, capabilitiesRouter)
app.use('/api/modules', authToken, modulesRouter)

app.use(notFoundHandler)
app.use(errorHandler)

app.listen(env.port, () => {
  console.log(`webcloud-ai-api listening on port ${env.port}`)

  // Il catalogo rinnovi è la sorgente più pesante dell'applicazione. Lo
  // carichiamo appena il processo è disponibile, senza ritardare health e
  // readiness, così la prima domanda dell'utente non paga il cold start CRM.
  if (env.renewalsApiBaseUrl && env.crmToken) {
    const startedAt = Date.now()

    Promise.allSettled([getAllServices(), getSettings(), getServiceOptions()]).then(results => {
      const failed = results.filter(result => result.status === 'rejected')

      console.log(
        '[renewals-prewarm]',
        JSON.stringify({
          ok: failed.length === 0,
          durationMs: Date.now() - startedAt,
          failed: failed.length,
        })
      )
    })
  }
})
