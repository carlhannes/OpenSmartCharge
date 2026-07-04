import { test, expect } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../core/db.js'
import { createApiRouter, type ApiDeps } from './api.js'

async function withApi(deps: ApiDeps, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use('/api', createApiRouter(deps))
  const server = app.listen(0)
  await new Promise<void>((r) => server.on('listening', () => r()))
  const port = (server.address() as AddressInfo).port
  try {
    await fn(`http://localhost:${port}`)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
}

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

  await withApi(deps, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/loadpoints/garage/start`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(started).toBe(true)
  })
})

// Regression: /api/transactions/:id per-sample energy must be the session delta from meterStart,
// not the charger's absolute lifetime register (which would offset a cumulative-energy chart).
test('GET /api/transactions/:id returns per-sample energy as delta from meterStart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-api-test-'))
  const db = openDb(dir)
  db.prepare(
    `INSERT INTO transactions (id, loadpoint_name, station_id, start_time, meter_start)
     VALUES (7, 'lp', 'STN', '2026-07-04T10:00:00Z', 1000000)`,
  ).run() // meterStart = 1,000,000 Wh = 1000 kWh
  db.prepare(
    `INSERT INTO meter_values (transaction_id, measured_at, energy_kwh) VALUES
       (7, '2026-07-04T10:05:00Z', 1002.5),
       (7, '2026-07-04T10:10:00Z', 1005.0)`,
  ).run() // absolute register (kWh)
  const deps = {
    db,
    config: { loadpoints: [] },
    chargers: new Map(),
    loadpoints: new Map(),
  } as unknown as ApiDeps
  try {
    await withApi(deps, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/transactions/7`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        transaction: { meter_start: number }
        samples: Array<{ energy_kwh: number }>
      }
      expect(body.transaction.meter_start).toBe(1000000) // absolute meter_start still exposed
      expect(body.samples.map((s) => s.energy_kwh)).toEqual([2.5, 5.0]) // deltas, not 1002.5/1005
    })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
