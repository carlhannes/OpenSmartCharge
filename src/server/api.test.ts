import { test, expect } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { createApiRouter, type ApiDeps } from './api.js'

// Regression: the command endpoints must resolve the loadpoint's charger, not assume the
// loadpoint name equals the charger name (which 404'd whenever they differed).
test('command endpoints resolve loadpoint -> charger when names differ', async () => {
  let started = false
  const charger = {
    remoteStart: async () => {
      started = true
    },
  }
  const deps = {
    config: { loadpoints: [{ name: 'garage', charger: 'zaptec' }] },
    chargers: new Map([['zaptec', charger]]),
    loadpoints: new Map([['garage', { name: 'garage' }]]),
  } as unknown as ApiDeps

  const app = express()
  app.use(express.json())
  app.use('/api', createApiRouter(deps))
  const server = app.listen(0)
  await new Promise<void>((r) => server.on('listening', () => r()))
  const port = (server.address() as AddressInfo).port
  try {
    const res = await fetch(`http://localhost:${port}/api/loadpoints/garage/start`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(started).toBe(true)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})
