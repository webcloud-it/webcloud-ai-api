import cors from 'cors'
import express from 'express'

import {env} from './config/env.js'
import {errorHandler} from './middlewares/errorHandler.js'
import {notFoundHandler} from './middlewares/notFoundHandler.js'
import chatRouter from './routes/chat.js'
import modulesRouter from './routes/modules.js'
import capabilitiesRouter from './routes/capabilities.js'
import {authToken} from './middlewares/authToken.js'
import {attachRequestId} from './core/observability/chatAudit.js'
import {checkOllamaReadiness} from './core/providers/ollamaProvider.js'

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
  })
})

app.get('/ready', async (req, res) => {
  const ollama = await checkOllamaReadiness()
  const ready = !env.ollamaRequired || ollama.ok

  res.status(ready ? 200 : 503).json({
    ok: ready,
    service: 'webcloud-ai-api',
    dependencies: {
      ollama: {...ollama, required: env.ollamaRequired},
    },
  })
})

app.use('/api/chat', attachRequestId, authToken, chatRouter)
app.use('/api/capabilities', authToken, capabilitiesRouter)
app.use('/api/modules', authToken, modulesRouter)

app.use(notFoundHandler)
app.use(errorHandler)

app.listen(env.port, () => {
  console.log(`webcloud-ai-api listening on port ${env.port}`)
})
