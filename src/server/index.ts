import express from 'express'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { ApiDeps } from './api.js'
import { createApiRouter } from './api.js'
import { createSseHandler } from './sse.js'

export function startServer(port: number, deps: ApiDeps): Server {
  const app = express()
  app.use(express.json())

  app.use('/api', createApiRouter(deps))
  app.get('/events', createSseHandler(deps.events))

  // In production, serve the bundled React app. Vite owns this in dev mode.
  if (process.env.NODE_ENV !== 'development') {
    const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/ui')
    app.use(express.static(uiDir))
    // SPA fallback — deep links return index.html so React Router handles routing
    app.use((_req, res) => res.sendFile(path.join(uiDir, 'index.html')))
  }

  const httpServer = createServer(app)
  httpServer.listen(port)
  return httpServer
}
