import { test, expect } from 'vitest'
import {
  getChargingStatus,
  getAirConditioning,
  getVehicleDetails,
  startCharging,
  stopCharging,
} from './api.js'

// The api layer is a thin authenticated GET over MySkoda. Two things matter: it maps the response
// JSON straight through (no reshaping — the module does that), and it surfaces rate-limiting (429/
// 430) as a DISTINCT, legible error so a hard limit is unmistakable in logs.

type FakeInit = { status?: number; headers?: Record<string, string>; body?: unknown }
function fakeFetch(spec: FakeInit, seen: { url?: string; auth?: string | null } = {}) {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.url = String(url)
    seen.auth = new Headers(init?.headers).get('authorization')
    const status = spec.status ?? 200
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(spec.headers ?? {}),
      json: async () => spec.body ?? {},
    }
  }) as unknown as typeof globalThis.fetch
}

test('getChargingStatus passes the response through and sends the bearer token', async () => {
  const body = {
    status: {
      battery: { stateOfChargeInPercent: 60, remainingCruisingRangeInMeters: 257000 },
      state: 'CHARGING',
      chargePowerInKw: 5,
      remainingTimeToFullyChargedInMinutes: 120,
    },
    settings: { targetStateOfChargeInPercent: 80 },
  }
  const seen: { url?: string; auth?: string | null } = {}
  const res = await getChargingStatus('VIN123', 'tok-abc', fakeFetch({ body }, seen))
  expect(res.status?.battery?.stateOfChargeInPercent).toBe(60)
  expect(res.status?.state).toBe('CHARGING')
  expect(res.settings?.targetStateOfChargeInPercent).toBe(80)
  expect(seen.url).toBe('https://mysmob.api.connect.skoda-auto.cz/api/v1/charging/VIN123')
  expect(seen.auth).toBe('Bearer tok-abc')
})

test('getAirConditioning surfaces plug + climate state', async () => {
  const res = await getAirConditioning(
    'VIN123',
    'tok',
    fakeFetch({ body: { state: 'HEATING', chargerConnectionState: 'CONNECTED' } }),
  )
  expect(res.chargerConnectionState).toBe('CONNECTED')
  expect(res.state).toBe('HEATING')
})

test('getVehicleDetails requests all connectivity generations', async () => {
  const seen: { url?: string } = {}
  await getVehicleDetails('VIN123', 'tok', fakeFetch({ body: {} }, seen))
  expect(seen.url).toContain('/v2/garage/vehicles/VIN123?')
  expect(seen.url).toContain('connectivityGenerations=MOD1')
  expect(seen.url).toContain('connectivityGenerations=MOD4')
})

test('429 → distinct rate-limit error carrying retry-after', async () => {
  await expect(
    getChargingStatus('VIN', 'tok', fakeFetch({ status: 429, headers: { 'retry-after': '600' } })),
  ).rejects.toThrow(/rate limited.*429.*retry-after 600s/)
})

test('430 (VW hard limit) is also treated as rate-limiting', async () => {
  await expect(getChargingStatus('VIN', 'tok', fakeFetch({ status: 430 }))).rejects.toThrow(
    /rate limited.*430/,
  )
})

test('other non-2xx statuses throw a plain HTTP error (not rate-limit)', async () => {
  const err = await getChargingStatus('VIN', 'tok', fakeFetch({ status: 500 })).catch((e) => e)
  expect(String(err)).toMatch(/HTTP 500/)
  expect(String(err)).not.toMatch(/rate limited/)
})

test('startCharging POSTs to /start with the bearer token, accepting a 202', async () => {
  const seen: { url?: string; auth?: string | null; method?: string } = {}
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    seen.url = String(url)
    seen.auth = new Headers(init?.headers).get('authorization')
    seen.method = init?.method
    return { status: 202, ok: true, headers: new Headers(), json: async () => ({}) }
  }) as unknown as typeof globalThis.fetch
  await startCharging('VIN123', 'tok-abc', fetchFn)
  expect(seen.method).toBe('POST')
  expect(seen.url).toBe('https://mysmob.api.connect.skoda-auto.cz/api/v1/charging/VIN123/start')
  expect(seen.auth).toBe('Bearer tok-abc')
})

test('stopCharging POSTs to /stop', async () => {
  const seen: { url?: string; method?: string } = {}
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    seen.url = String(url)
    seen.method = init?.method
    return { status: 202, ok: true, headers: new Headers(), json: async () => ({}) }
  }) as unknown as typeof globalThis.fetch
  await stopCharging('VIN123', 'tok', fetchFn)
  expect(seen.method).toBe('POST')
  expect(seen.url).toBe('https://mysmob.api.connect.skoda-auto.cz/api/v1/charging/VIN123/stop')
})

test('a failed start-charge surfaces the HTTP error (so the reconciler can escalate)', async () => {
  await expect(startCharging('VIN', 'tok', fakeFetch({ status: 500 }))).rejects.toThrow(/HTTP 500/)
  // Rate-limiting stays distinct on the POST path too.
  await expect(startCharging('VIN', 'tok', fakeFetch({ status: 429 }))).rejects.toThrow(
    /rate limited.*429/,
  )
})
