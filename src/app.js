import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'

dotenv.config()

const app = express()
const port = process.env.PORT || 3000

app.use(cors())
app.use(express.json({limit: '2mb'}))

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'webcloud-ai-api',
  })
})

app.listen(port, () => {
  console.log(`webcloud-ai-api listening on port ${port}`)
})
