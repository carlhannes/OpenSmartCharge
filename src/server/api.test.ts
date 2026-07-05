import { test, expect } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../core/db.js'
import { configSchema } from '../core/config.js'
import { getEffectiveConfig, getOverride } from '../core/config-overrides.js'
import { createApiRouter, type ApiDeps } from './api.js'

const putJson = (url: string, body: unknown) =>
  fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

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

test('plans carry resolvedSoc; loadpoints carry availableTargetUnits (backend owns km→%)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-api-plans-'))
  const db = openDb(dir)
  try {
    // A car reporting soc + range + capacity → all three units backable; km resolves via the ratio.
    const vehicle = {
      getData: async () => ({ soc: 60, range: 300, batteryCapacity: 60, fetchedAt: new Date() }),
      getCachedCapacity: () => 60,
    }
    const deps = {
      db,
      events: { emit() {} },
      config: { loadpoints: [{ name: 'garage', charger: 'garage', vehicle: 'car' }] },
      chargers: new Map(),
      loadpoints: new Map([['garage', { name: 'garage' }]]),
      vehicles: new Map([['car', vehicle]]),
      onPlansChanged: () => {},
    } as unknown as ApiDeps
    await withApi(deps, async (baseUrl) => {
      // 300 km at 60% → 5 km/% → 350 km ⇒ resolvedSoc 70.
      const cr = await fetch(`${baseUrl}/api/loadpoints/garage/plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: ['mon'], readyBy: '07:00', target: 350, unit: 'km' }),
      })
      expect(((await cr.json()) as { resolvedSoc: number }).resolvedSoc).toBe(70)
      const lps = (await (await fetch(`${baseUrl}/api/loadpoints`)).json()) as {
        availableTargetUnits: string[]
      }[]
      expect(lps[0].availableTargetUnits).toEqual(['pct', 'km', 'kwh'])
    })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no vehicle → km plan resolvedSoc null, only kwh offered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-api-plans-'))
  const db = openDb(dir)
  try {
    await withApi(planDeps(db, { n: 0 }), async (baseUrl) => {
      const cr = await fetch(`${baseUrl}/api/loadpoints/garage/plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: ['mon'], readyBy: '07:00', target: 350, unit: 'km' }),
      })
      expect(((await cr.json()) as { resolvedSoc: number | null }).resolvedSoc).toBeNull()
      const lps = (await (await fetch(`${baseUrl}/api/loadpoints`)).json()) as {
        availableTargetUnits: string[]
      }[]
      expect(lps[0].availableTargetUnits).toEqual(['kwh'])
    })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PUT site/tariff/balancer persist overrides + reconcile; GET /api/site reflects them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-api-cfg-'))
  const db = openDb(dir)
  try {
    const config = configSchema.parse({
      site: { mainBreakerA: 25 },
      tariffs: [{ name: 'home', type: 'elprisetjustnu', zone: 'SE3' }],
      balancers: [{ name: 'main', type: 'mqtt-circuit', mainBreakerA: 25, phases: 3 }],
      chargers: [{ name: 'garage', type: 'ocpp16', stationId: 'ST1' }],
      loadpoints: [{ name: 'garage', charger: 'garage' }],
    })
    const base = structuredClone(config)
    // Faithful mini-reconcile: recompute the effective config from base + DB overrides and mutate
    // the live config object in place (what the real reconcile does, minus the module rebuild).
    const applyEff = () => Object.assign(config, getEffectiveConfig(base, db))
    const deps = {
      db,
      config,
      loadpoints: new Map([['garage', { name: 'garage', maxCurrentA: 16, autoStart: true }]]),
      events: { emit: () => true },
      reconcile: {
        reloadSite: () => applyEff(),
        reloadTariff: async () => applyEff(),
        reloadBalancer: async () => applyEff(),
      },
    } as unknown as ApiDeps

    await withApi(deps, async (baseUrl) => {
      expect((await putJson(`${baseUrl}/api/site`, { mainBreakerA: -1 })).status).toBe(400)
      expect((await putJson(`${baseUrl}/api/site`, { mainBreakerA: 16 })).status).toBe(200)

      const t = await putJson(`${baseUrl}/api/tariffs/home`, { zone: 'SE4' })
      expect(((await t.json()) as { zone: string }).zone).toBe('SE4')
      expect((await putJson(`${baseUrl}/api/tariffs/nope`, { zone: 'SE4' })).status).toBe(404)

      expect(
        (await putJson(`${baseUrl}/api/balancers/main`, { mainBreakerA: 20, phases: 1 })).status,
      ).toBe(200)
      expect((await putJson(`${baseUrl}/api/balancers/main`, { phases: 5 })).status).toBe(400)

      const site = (await (await fetch(`${baseUrl}/api/site`)).json()) as {
        site: { mainBreakerA: number; timezone: string }
        tariffs: { zone?: string }[]
        balancers: { mainBreakerA: number; phases: number }[]
      }
      expect(site.site.mainBreakerA).toBe(16)
      expect(typeof site.site.timezone).toBe('string') // runtime value, always present
      expect(site.tariffs[0].zone).toBe('SE4')
      expect(site.balancers[0].mainBreakerA).toBe(20)
      expect(site.balancers[0].phases).toBe(1)
      // overrides persisted for config:apply / reboot
      expect(getOverride(db, 'tariff', 'home')).toEqual({ zone: 'SE4' })
      expect(getOverride(db, 'site', 'site')).toEqual({ mainBreakerA: 16 })
    })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /target validates minSoc and passes it through', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-api-minsoc-'))
  const db = openDb(dir)
  let captured: number | undefined = -1
  const deps = {
    db,
    events: { emit() {} },
    config: { loadpoints: [{ name: 'garage', charger: 'garage' }] },
    chargers: new Map(),
    loadpoints: new Map([['garage', { name: 'garage' }]]),
    onTargetChange: async (_n: string, _s?: number, _t?: string, _k?: number, minSoc?: number) => {
      captured = minSoc
    },
    onPlansChanged: () => {},
  } as unknown as ApiDeps
  try {
    await withApi(deps, async (baseUrl) => {
      const post = (body: unknown) =>
        fetch(`${baseUrl}/api/loadpoints/garage/target`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      expect((await post({ minSoc: 150 })).status).toBe(400) // out of range
      expect((await post({ minSoc: 25 })).status).toBe(200)
      expect(captured).toBe(25) // parsed + threaded to onTargetChange
    })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
