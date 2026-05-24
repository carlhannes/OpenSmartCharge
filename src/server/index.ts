import express from 'express'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import type { ApiDeps } from './api.js'
import { createApiRouter } from './api.js'
import { createSseHandler } from './sse.js'

export function startServer(port: number, deps: ApiDeps): Server {
  const app = express()
  app.use(express.json())

  app.use('/api', createApiRouter(deps))
  app.get('/events', createSseHandler(deps.events))

  const httpServer = createServer(app)
  httpServer.listen(port)
  return httpServer
}
