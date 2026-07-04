import { test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import pino from 'pino'
import type { DatabaseSync } from 'node:sqlite'
import './index.js' // side-effect: registers the 'skoda' vehicle module
import { getVehicleModule } from '../../sdk/registry-api.js'
import { openDb } from '../../core/db.js'
import { saveRefreshToken } from './persistence.js'
import type { ModuleCtx } from '../../sdk/types.js'

// End-to-end module contract: refresh() runs auth (via a seeded refresh token) → the api layer →
// maps MySkoda's shape into VehicleData → writes the cache. Global fetch serves ONLY the VW token
// refresh; the per-request ctx.fetch serves the MySkoda data endpoints (so we assert the module
// uses the jittered ctx.fetch for data, not the global one).

const log = pino({ level: 'silent' })
const VIN = 'TMBABABABABABABAB' // 17 chars

const CHARGING = {
  status: {
    battery: { stateOfChargeInPercent: 60, remainingCruisingRangeInMeters: 257000 },
    state: 'CHARGING',
    chargePowerInKw: 5,
    remainingTimeToFullyChargedInMinutes: 120,
  },
  settings: { targetStateOfChargeInPercent: 80 },
}

const origFetch = globalThis.fetch
const tmpDirs: string[] = []
afterEach(() => {
  globalThis.fetch = origFetch
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'osc-veh-test-'))
  tmpDirs.push(dir)
  return openDb(dir)
}

// ctx.fetch serving the three MySkoda data endpoints by path.
function dataFetch(bodies: { charging?: unknown; aircon?: unknown; details?: unknown }) {
  return (async (url: string | URL) => {
    const u = String(url)
    if (u.includes('/air-conditioning/')) {
      if (bodies.aircon === undefined) return new Response('', { status: 500 })
      return new Response(JSON.stringify(bodies.aircon), { status: 200 })
    }
    if (u.includes('/charging/')) return new Response(JSON.stringify(bodies.charging), { status: 200 })
    if (u.includes('/garage/vehicles/'))
      return new Response(JSON.stringify(bodies.details ?? {}), { status: 200 })
    return new Response('', { status: 404 })
  }) as unknown as typeof globalThis.fetch
}

function makeCtx(db: DatabaseSync, ctxFetch: typeof globalThis.fetch): ModuleCtx {
  return { db, events: new EventEmitter(), log, fetch: ctxFetch }
}

// Global fetch that answers only the VW token-refresh POST.
function stubTokenRefresh() {
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes('/authentication/refresh-token'))
      return new Response(JSON.stringify({ accessToken: 'at', refreshToken: 'rt2' }), { status: 200 })
    return new Response('', { status: 404 })
  }) as unknown as typeof globalThis.fetch
}

test('refresh() maps SoC/range/state/target/power + plug + climate, and caches it', async () => {
  const db = freshDb()
  saveRefreshToken(db, 'enyaq', 'seed-refresh') // skip the HTML login; go straight to refresh
  stubTokenRefresh()
  const ctx = makeCtx(
    db,
    dataFetch({
      charging: CHARGING,
      aircon: { state: 'HEATING', chargerConnectionState: 'CONNECTED' },
      details: { specification: { battery: { capacityInKWh: 77 } } },
    }),
  )
  const v = getVehicleModule('skoda')!.create({ name: 'enyaq', username: 'u', password: 'p', vin: VIN }, ctx)

  const data = await v.refresh()
  expect(data.soc).toBe(60)
  expect(data.range).toBe(257) // 257000 m → km
  expect(data.isCharging).toBe(true)
  expect(data.state).toBe('CHARGING')
  expect(data.targetSoc).toBe(80)
  expect(data.chargePowerKw).toBe(5)
  expect(data.remainingChargeMinutes).toBe(120)
  expect(data.pluggedIn).toBe(true) // chargerConnectionState CONNECTED
  expect(data.climateActive).toBe(true) // state HEATING
  expect(data.batteryCapacity).toBe(77)
  expect(v.getCachedCapacity()).toBe(77)
  expect(v.health()).toBe('ok')

  // getData() returns the cached reading without hitting the network.
  expect((await v.getData()).soc).toBe(60)

  // Persisted to vehicle_cache.
  const row = db.prepare('SELECT soc, battery_capacity_kwh, is_charging FROM vehicle_cache WHERE vehicle_name = ?').get('enyaq') as
    | { soc: number; battery_capacity_kwh: number; is_charging: number }
    | undefined
  expect(row).toMatchObject({ soc: 60, battery_capacity_kwh: 77, is_charging: 1 })
})

test('idle car: not charging, cable out, climate off → flags map to false', async () => {
  const db = freshDb()
  saveRefreshToken(db, 'enyaq', 'seed')
  stubTokenRefresh()
  const ctx = makeCtx(
    db,
    dataFetch({
      charging: { status: { battery: { stateOfChargeInPercent: 42 }, state: 'READY_FOR_CHARGING' } },
      aircon: { state: 'OFF', chargerConnectionState: 'DISCONNECTED' },
      details: { specification: { battery: { capacityInKWh: 77 } } },
    }),
  )
  const v = getVehicleModule('skoda')!.create({ name: 'enyaq', username: 'u', password: 'p', vin: VIN }, ctx)
  const data = await v.refresh()
  expect(data.isCharging).toBe(false)
  expect(data.pluggedIn).toBe(false)
  expect(data.climateActive).toBe(false)
  expect(data.state).toBe('READY_FOR_CHARGING')
})

test('air-conditioning endpoint failure degrades gracefully (plug/climate undefined, SoC still read)', async () => {
  const db = freshDb()
  saveRefreshToken(db, 'enyaq', 'seed')
  stubTokenRefresh()
  const ctx = makeCtx(
    db,
    dataFetch({ charging: CHARGING, aircon: undefined, details: { specification: { battery: { capacityInKWh: 77 } } } }),
  )
  const v = getVehicleModule('skoda')!.create({ name: 'enyaq', username: 'u', password: 'p', vin: VIN }, ctx)
  const data = await v.refresh()
  expect(data.soc).toBe(60) // primary read still succeeds
  expect(data.pluggedIn).toBeUndefined()
  expect(data.climateActive).toBeUndefined()
})

test('refresh() throws when the charging response has no SoC', async () => {
  const db = freshDb()
  saveRefreshToken(db, 'enyaq', 'seed')
  stubTokenRefresh()
  const ctx = makeCtx(db, dataFetch({ charging: { status: { state: 'CONNECT_CABLE' } }, aircon: { state: 'OFF' } }))
  const v = getVehicleModule('skoda')!.create({ name: 'enyaq', username: 'u', password: 'p', vin: VIN }, ctx)
  await expect(v.refresh()).rejects.toThrow(/no SoC/)
})
