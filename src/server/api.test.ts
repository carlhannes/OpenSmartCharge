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

const postJson = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
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

// Coverage endpoints (Phase A): validate BEFORE persisting, reconcile live, and flag boot-captured
// fields as restart-required. smartcharging is the representative case; meters/tariffs/balancers
// follow the same setOverride → validateConfigWith → reconcile pattern.
test('PUT /api/smartcharging: validate-first, live reconcile, restart-required for controlIntervalSec', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-api-sc-'))
  const db = openDb(dir)
  const calls: string[] = []
  const deps = {
    db,
    config: configSchema.parse({ site: { mainBreakerA: 16 } }),
    reconcile: { reloadSmartCharging: () => calls.push('reloadSmartCharging') },
  } as unknown as ApiDeps
  try {
    await withApi(deps, async (baseUrl) => {
      // valid live change → 200, reconciled, no restart needed
      const ok = await putJson(`${baseUrl}/api/smartcharging`, { reserveA: 2 })
      expect(ok.status).toBe(200)
      expect((await ok.json()).restartRequired).toBeUndefined()
      expect(calls).toContain('reloadSmartCharging')
      expect(getOverride(db, 'smartCharging', 'smartCharging')).toEqual({ reserveA: 2 })
      // controlIntervalSec is boot-captured → flagged restart-required
      const rc = await putJson(`${baseUrl}/api/smartcharging`, { controlIntervalSec: 20 })
      expect(await rc.json()).toMatchObject({
        restartRequired: true,
        restartFields: ['controlIntervalSec'],
      })
      // invalid value → 400 and NOT persisted (validate-first)
      const bad = await putJson(`${baseUrl}/api/smartcharging`, { reserveA: -1 })
      expect(bad.status).toBe(400)
      expect(getOverride(db, 'smartCharging', 'smartCharging')).not.toMatchObject({ reserveA: -1 })
    })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// Config export/import over HTTP: export redacts creds (unless ?secrets=1); import validates + is
// restart-required; a bad mode/body is 400. The merge/replace/redaction semantics are unit-tested in
// config-io.test.ts — this covers the wire contract.
test('GET /config/export + POST /config/import round-trip over HTTP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-api-cfgio-'))
  const db = openDb(dir)
  const config = configSchema.parse({
    site: { mainBreakerA: 16 },
    vehicles: [{ name: 'enyaq', type: 'skoda', password: 'real-secret' }],
    loadpoints: [{ name: 'garage', charger: 'zaptec', vehicle: 'enyaq' }],
  })
  const deps = {
    db,
    config,
    loadpoints: new Map([['garage', { mode: 'smart', targetSoc: 75 }]]),
    events: { emit() {} },
  } as unknown as ApiDeps
  try {
    await withApi(deps, async (baseUrl) => {
      // export redacts by default
      const red = await fetch(`${baseUrl}/api/config/export`)
      expect(red.status).toBe(200)
      const redYaml = await red.text()
      expect(redYaml).toContain('mainBreakerA: 16')
      expect(redYaml).not.toContain('real-secret')
      // ?secrets=1 includes the plaintext credential
      const full = await (await fetch(`${baseUrl}/api/config/export?secrets=1`)).text()
      expect(full).toContain('real-secret')

      // re-import the redacted export (merge) → applied, restart-required
      const imp = await postJson(`${baseUrl}/api/config/import`, { config: redYaml, mode: 'merge' })
      expect(imp.status).toBe(200)
      expect(await imp.json()).toMatchObject({ mode: 'merge', restartRequired: true })
      // the redacted password must resolve back to the real one (de-redacted), not be clobbered
      expect(
        (getOverride(db, 'vehicle', 'enyaq') as { password?: string } | undefined)?.password,
      ).toBe('real-secret')

      // bad mode → 400
      expect(
        (await postJson(`${baseUrl}/api/config/import`, { config: {}, mode: 'x' })).status,
      ).toBe(400)
    })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

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

// POST /api/tariffs/:name/refresh forces an out-of-band fetch and returns the resulting health;
// 404 for an unknown tariff, 501 when the provider doesn't implement refresh.
test('POST /api/tariffs/:name/refresh triggers refresh and reports health', async () => {
  let refreshed = false
  const tariff = {
    refresh: async () => {
      refreshed = true
    },
    health: () => 'ok',
  }
  const noRefresh = { health: () => 'degraded' }
  const deps = {
    tariffs: new Map([
      ['home', tariff],
      ['legacy', noRefresh],
    ]),
  } as unknown as ApiDeps

  await withApi(deps, async (baseUrl) => {
    const ok = await postJson(`${baseUrl}/api/tariffs/home/refresh`, {})
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ name: 'home', health: 'ok' })
    expect(refreshed).toBe(true)

    expect((await postJson(`${baseUrl}/api/tariffs/nope/refresh`, {})).status).toBe(404)
    expect((await postJson(`${baseUrl}/api/tariffs/legacy/refresh`, {})).status).toBe(501)
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

test('POST /vehicles/:name/refresh forces one live poll + returns fresh data; 404 for unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-api-vrefresh-'))
  const db = openDb(dir)
  try {
    let polls = 0
    const vehicle = {
      refresh: async () => {
        polls++
        return { soc: 72, range: 310, climateActive: true, fetchedAt: new Date() }
      },
      health: () => 'ok',
      getCachedCapacity: () => 77,
    }
    const deps = {
      db,
      events: { emit() {} },
      config: { loadpoints: [] },
      chargers: new Map(),
      loadpoints: new Map(),
      vehicles: new Map([['car', vehicle]]),
    } as unknown as ApiDeps
    await withApi(deps, async (baseUrl) => {
      const r = await postJson(`${baseUrl}/api/vehicles/car/refresh`, {})
      expect(r.status).toBe(200)
      const body = (await r.json()) as {
        data: { soc: number; climateActive: boolean }
        capacityKWh: number
      }
      expect(body.data.soc).toBe(72)
      expect(body.data.climateActive).toBe(true) // the field the climate feature keys on
      expect(body.capacityKWh).toBe(77)
      expect(polls).toBe(1) // hit the live poll exactly once
      expect((await postJson(`${baseUrl}/api/vehicles/nope/refresh`, {})).status).toBe(404)
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
      loadpoints: new Map([['garage', { name: 'garage', maxCurrentA: 16 }]]),
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
      // per-breaker static-tod margins (replace the deprecated flat safeStaticCurrentA)
      expect(
        (await putJson(`${baseUrl}/api/balancers/main`, { nightMarginA: 6, daytimeFraction: 0.4 }))
          .status,
      ).toBe(200)
      expect(getOverride(db, 'balancer', 'main')).toMatchObject({
        nightMarginA: 6,
        daytimeFraction: 0.4,
      })
      expect(
        (await putJson(`${baseUrl}/api/balancers/main`, { daytimeFraction: 1.5 })).status,
      ).toBe(400)
      expect((await putJson(`${baseUrl}/api/balancers/main`, { nightMarginA: -1 })).status).toBe(
        400,
      )

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

test('charger management: pending list, claim (+ loadpoint), edit (merge), remove', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-api-chg-'))
  const db = openDb(dir)
  try {
    const config = configSchema.parse({ chargers: [], loadpoints: [] })
    const loadpoints = new Map<string, unknown>()
    // Stub reconcile mirroring the real config/Map mutations (no real OCPP modules in the test).
    const reconcile = {
      addCharger: async (name: string) => {
        config.chargers.push({ name, ...getOverride(db, 'charger', name) } as never)
      },
      addLoadpoint: (name: string) => {
        config.loadpoints.push({ name, ...getOverride(db, 'loadpoint', name) } as never)
        loadpoints.set(name, { name })
      },
      reloadCharger: async () => {},
      removeCharger: async (name: string) => {
        config.chargers = config.chargers.filter((c) => c.name !== name)
      },
      removeLoadpoint: (name: string) => {
        config.loadpoints = config.loadpoints.filter((l) => l.name !== name)
        loadpoints.delete(name)
      },
    }
    const deps = { db, config, loadpoints, events: { emit() {} }, reconcile } as unknown as ApiDeps

    await withApi(deps, async (baseUrl) => {
      // no OCPP server in-process → empty pending list
      expect(await (await fetch(`${baseUrl}/api/chargers/pending`)).json()).toEqual([])

      expect(
        (await postJson(`${baseUrl}/api/chargers`, { stationId: 'ST9', name: 'g2', maxA: 20 }))
          .status,
      ).toBe(201)
      expect(getOverride(db, 'charger', 'g2')).toMatchObject({
        type: 'ocpp16',
        stationId: 'ST9',
        maxA: 20,
      })
      expect(getOverride(db, 'loadpoint', 'g2')).toMatchObject({
        charger: 'g2',
        defaultMode: 'smart',
      })

      expect(
        (await postJson(`${baseUrl}/api/chargers`, { stationId: 'ST9', name: 'g2' })).status,
      ).toBe(409) // dup name
      expect(
        (await postJson(`${baseUrl}/api/chargers`, { stationId: 'ST8', name: 'g3', maxA: -1 }))
          .status,
      ).toBe(400)
      expect((await postJson(`${baseUrl}/api/chargers`, { name: 'g4' })).status).toBe(400) // missing stationId

      expect((await putJson(`${baseUrl}/api/chargers/g2`, { maxA: 10 })).status).toBe(200)
      expect(getOverride(db, 'charger', 'g2')).toMatchObject({
        maxA: 10,
        stationId: 'ST9',
        type: 'ocpp16',
      }) // merged
      expect((await putJson(`${baseUrl}/api/chargers/nope`, { maxA: 10 })).status).toBe(404)

      // label surfaces on GET /api/site.chargers[] (defaults to the name) — the ui2 follow-up.
      const siteChargers = (
        (await (await fetch(`${baseUrl}/api/site`)).json()) as {
          chargers: { name: string; label: string }[]
        }
      ).chargers
      expect(siteChargers.find((ch) => ch.name === 'g2')?.label).toBe('g2')

      // Guard: deleting a charger mid-session is refused with 409 + a user-facing hint …
      loadpoints.set('g2', { name: 'g2', charging: true })
      const blocked = await fetch(`${baseUrl}/api/chargers/g2`, { method: 'DELETE' })
      expect(blocked.status).toBe(409)
      expect(await blocked.json()).toMatchObject({
        hint: 'Please disable this charger before deleting it.',
      })
      expect(getOverride(db, 'charger', 'g2')).toBeDefined() // refused — still there

      // … unless ?force=true (the "hardware is already gone" escape hatch).
      expect(
        (await fetch(`${baseUrl}/api/chargers/g2?force=true`, { method: 'DELETE' })).status,
      ).toBe(204)
      expect(getOverride(db, 'charger', 'g2')).toBeUndefined()
      expect(getOverride(db, 'loadpoint', 'g2')).toBeUndefined() // its loadpoint cleaned up too
    })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vehicle management: add (creds hidden + persisted), bind to loadpoint, remove', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-api-veh-'))
  const db = openDb(dir)
  try {
    const config = configSchema.parse({
      vehicles: [],
      loadpoints: [{ name: 'garage', charger: 'garage' }],
    })
    const vehicles = new Map<string, unknown>()
    const reconcile = {
      addVehicle: async (name: string) => {
        config.vehicles.push({ name, ...getOverride(db, 'vehicle', name) } as never)
        vehicles.set(name, {
          refresh: async () => ({}),
          health: () => 'ok',
          stop: async () => {},
        })
      },
      removeVehicle: async (name: string) => {
        config.vehicles = config.vehicles.filter((v) => v.name !== name)
        vehicles.delete(name)
        for (const lp of config.loadpoints) if (lp.vehicle === name) lp.vehicle = undefined
      },
      reloadLoadpoint: (name: string) => {
        const lp = config.loadpoints.find((l) => l.name === name)
        if (lp) Object.assign(lp, getOverride(db, 'loadpoint', name))
      },
    }
    const deps = {
      db,
      config,
      vehicles,
      loadpoints: new Map([['garage', { name: 'garage' }]]),
      tariffs: new Map(),
      balancers: new Map(),
      events: { emit() {} },
      reconcile,
    } as unknown as ApiDeps

    await withApi(deps, async (baseUrl) => {
      const vin = 'A'.repeat(17)
      const r = await postJson(`${baseUrl}/api/vehicles`, {
        name: 'enyaq2',
        username: 'u',
        password: 'p',
        vin,
      })
      expect(r.status).toBe(201)
      expect(await r.json()).toEqual({ name: 'enyaq2', type: 'skoda', vin }) // NO credentials echoed
      expect(getOverride(db, 'vehicle', 'enyaq2')).toMatchObject({
        username: 'u',
        password: 'p',
        vin,
      }) // stored server-side

      expect(
        (
          await postJson(`${baseUrl}/api/vehicles`, {
            name: 'enyaq2',
            username: 'u',
            password: 'p',
            vin,
          })
        ).status,
      ).toBe(409)
      expect(
        (
          await postJson(`${baseUrl}/api/vehicles`, {
            name: 'x',
            username: 'u',
            password: 'p',
            vin: 'short',
          })
        ).status,
      ).toBe(400)
      expect(
        (await postJson(`${baseUrl}/api/vehicles`, { name: 'x', username: 'u', vin })).status,
      ).toBe(400) // no password

      // bind to a loadpoint (ref must exist)
      expect(
        (await putJson(`${baseUrl}/api/loadpoints/garage`, { vehicle: 'enyaq2' })).status,
      ).toBe(200)
      expect(getOverride(db, 'loadpoint', 'garage')).toMatchObject({ vehicle: 'enyaq2' })
      expect((await putJson(`${baseUrl}/api/loadpoints/garage`, { vehicle: 'ghost' })).status).toBe(
        400,
      )

      expect((await fetch(`${baseUrl}/api/vehicles/enyaq2`, { method: 'DELETE' })).status).toBe(204)
      expect(getOverride(db, 'vehicle', 'enyaq2')).toBeUndefined()
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

test('POST /loadpoints/:name/vehicle: null (auto) / "guest" / any configured vehicle accepted, unknown → 400, unknown loadpoint → 404', async () => {
  const calls: Array<[string, string | null]> = []
  const deps = {
    config: {
      loadpoints: [{ name: 'garage', charger: 'g', vehicle: 'enyaq' }],
      vehicles: [
        { name: 'enyaq', type: 'skoda' },
        { name: 'opel', type: 'manual' },
      ],
    },
    loadpoints: new Map([['garage', { name: 'garage' }]]),
    onVehicleOverride: async (name: string, v: string | null) => void calls.push([name, v]),
  } as unknown as ApiDeps
  await withApi(deps, async (baseUrl) => {
    const post = (b: unknown) => postJson(`${baseUrl}/api/loadpoints/garage/vehicle`, b)
    expect((await post({ vehicle: null })).status).toBe(200) // Auto (clear the override)
    expect((await post({ vehicle: 'guest' })).status).toBe(200) // force Guest
    expect((await post({ vehicle: 'enyaq' })).status).toBe(200) // force an app car
    expect((await post({ vehicle: 'opel' })).status).toBe(200) // force a manual car
    expect((await post({ vehicle: 'nobody' })).status).toBe(400) // not a configured vehicle
    expect(
      (await postJson(`${baseUrl}/api/loadpoints/nope/vehicle`, { vehicle: null })).status,
    ).toBe(404)
    expect(calls).toEqual([
      ['garage', null],
      ['garage', 'guest'],
      ['garage', 'enyaq'],
      ['garage', 'opel'],
    ])
  })
})

test('POST /loadpoints/:name/target: kwh null clears (threaded as null), a number is range-checked', async () => {
  const kwhArgs: Array<number | null | undefined> = []
  const deps = {
    loadpoints: new Map([['garage', { name: 'garage' }]]),
    onTargetChange: async (_n: string, _s?: number, _t?: string, kwh?: number | null) =>
      void kwhArgs.push(kwh),
  } as unknown as ApiDeps
  await withApi(deps, async (baseUrl) => {
    const post = (b: unknown) => postJson(`${baseUrl}/api/loadpoints/garage/target`, b)
    expect((await post({ kwh: null })).status).toBe(200) // explicit clear
    expect((await post({ kwh: 40 })).status).toBe(200)
    expect((await post({ kwh: 0 })).status).toBe(400) // < 1 → rejected, not treated as clear
    expect(kwhArgs).toEqual([null, 40]) // the 0 never reached the handler
  })
})

test('GET /api/loadpoints/:name/plan merges the price curve with the tick-computed schedule', async () => {
  const t = (h: number) => new Date(`2026-07-04T${String(h).padStart(2, '0')}:00:00Z`)
  const priceSlots = [
    { start: t(20), end: t(21), pricePerKWh: 2, currency: 'SEK' },
    { start: t(21), end: t(22), pricePerKWh: 0.1, currency: 'SEK' },
    { start: t(22), end: t(23), pricePerKWh: 0.5, currency: 'SEK' },
  ]
  const deps = {
    config: { loadpoints: [{ name: 'garage', charger: 'zaptec', tariff: 'spot' }] },
    loadpoints: new Map([
      [
        'garage',
        {
          name: 'garage',
          mode: 'smart',
          // a 15-min charging slot inside the middle (21:00) hour
          plannedSlots: [{ start: t(21), end: new Date('2026-07-04T21:15:00Z'), shouldCharge: true }],
          planReadyBy: t(21).getTime(),
        },
      ],
    ]),
    tariffs: new Map([['spot', { prices: async () => priceSlots, health: () => 'ok' }]]),
  } as unknown as ApiDeps

  await withApi(deps, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/loadpoints/garage/plan`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      mode: string
      readyBy: string
      window: { from: string; to: string }
      slots: { pricePerKWh: number; shouldCharge: boolean }[]
    }
    expect(body.mode).toBe('smart')
    expect(body.readyBy).toBe(t(21).toISOString())
    expect(body.window.from).toBeTruthy()
    // only the middle hour (overlapping the plan slot) charges
    expect(body.slots.map((s) => s.shouldCharge)).toEqual([false, true, false])
    expect(body.slots[1].pricePerKWh).toBe(0.1) // price carried through
    // unknown loadpoint → 404
    expect((await fetch(`${baseUrl}/api/loadpoints/nope/plan`)).status).toBe(404)
  })
})

test('GET /api/power-history returns the rolling power buffer', async () => {
  const samples = [
    { t: 1000, total: 3000, ev: 1000 },
    { t: 11000, total: 3400, ev: 1200 },
  ]
  const deps = { powerHistory: samples } as unknown as ApiDeps
  await withApi(deps, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/power-history`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(samples)
  })
})
