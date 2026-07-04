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

function planDeps(db: ReturnType<typeof openDb>, changed: { n: number }): ApiDeps {
  return {
    db,
    events: { emit() {} },
    config: { loadpoints: [{ name: 'garage', charger: 'garage' }] },
    chargers: new Map(),
    loadpoints: new Map([['garage', { name: 'garage' }]]),
    onPlansChanged: () => {
      changed.n++
    },
  } as unknown as ApiDeps
}

test('plan CRUD endpoints: create → list → update → delete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-api-plans-'))
  const db = openDb(dir)
  const changed = { n: 0 }
  try {
    await withApi(planDeps(db, changed), async (baseUrl) => {
      const cr = await fetch(`${baseUrl}/api/loadpoints/garage/plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: ['mon', 'fri'], readyBy: '07:00', target: 80, unit: 'pct' }),
      })
      expect(cr.status).toBe(201)
      const plan = (await cr.json()) as { id: string; days: string[]; enabled: boolean }
      expect(typeof plan.id).toBe('string') // ui2 wants a string id
      expect(plan.days).toEqual(['mon', 'fri'])
      expect(plan.enabled).toBe(true)

      const list = (await (
        await fetch(`${baseUrl}/api/loadpoints/garage/plans`)
      ).json()) as unknown[]
      expect(list).toHaveLength(1)

      const up = await fetch(`${baseUrl}/api/loadpoints/garage/plans/${plan.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }), // partial: only enabled
      })
      expect(up.status).toBe(200)
      const upBody = (await up.json()) as { enabled: boolean; days: string[] }
      expect(upBody.enabled).toBe(false)
      expect(upBody.days).toEqual(['mon', 'fri']) // untouched

      const del = await fetch(`${baseUrl}/api/loadpoints/garage/plans/${plan.id}`, {
        method: 'DELETE',
      })
      expect(del.status).toBe(204)
      expect(await (await fetch(`${baseUrl}/api/loadpoints/garage/plans`)).json()).toEqual([])
      expect(changed.n).toBe(3) // create + update + delete each notified the lifecycle
    })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST plan rejects invalid input with 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-api-plans-'))
  const db = openDb(dir)
  try {
    await withApi(planDeps(db, { n: 0 }), async (baseUrl) => {
      const post = (body: unknown) =>
        fetch(`${baseUrl}/api/loadpoints/garage/plans`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      expect((await post({ days: [], readyBy: '07:00', target: 80, unit: 'pct' })).status).toBe(400)
      expect((await post({ days: ['xx'], readyBy: '07:00', target: 80, unit: 'pct' })).status).toBe(
        400,
      )
      expect((await post({ days: ['mon'], readyBy: '7am', target: 80, unit: 'pct' })).status).toBe(
        400,
      )
      expect((await post({ days: ['mon'], readyBy: '07:00', target: 80, unit: 'x' })).status).toBe(
        400,
      )
      expect(
        (await post({ days: ['mon'], readyBy: '07:00', target: 150, unit: 'pct' })).status,
      ).toBe(400) // pct > 100
    })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
