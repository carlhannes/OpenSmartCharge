import { test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from './db.js'
import { configSchema } from './config.js'
import {
  getOverride,
  setOverride,
  deleteOverride,
  listOverrides,
  getEffectiveConfig,
  applyConfigOverrides,
} from './config-overrides.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'osc-cfgov-'))
  dirs.push(dir)
  return openDb(dir)
}

const base = configSchema.parse({
  site: { mainBreakerA: 25 },
  tariffs: [{ name: 'home', type: 'elprisetjustnu', zone: 'SE3' }],
  balancers: [{ name: 'main', type: 'mqtt-circuit', mainBreakerA: 25 }],
  vehicles: [{ name: 'car', type: 'skoda', vin: 'A'.repeat(17), username: 'u', password: 'p' }],
  chargers: [{ name: 'garage', type: 'ocpp16', stationId: 'ST1' }],
  loadpoints: [{ name: 'garage', charger: 'garage' }],
})

test('empty overrides → effective config equals the base (inert)', () => {
  expect(getEffectiveConfig(base, freshDb())).toEqual(base)
})

test('setOverride patches an existing entity; getEffectiveConfig applies it (base untouched)', () => {
  const db = freshDb()
  setOverride(db, 'tariff', 'home', { zone: 'SE4' })
  setOverride(db, 'site', 'site', { mainBreakerA: 16 })
  const eff = getEffectiveConfig(base, db)
  expect(eff.tariffs[0].zone).toBe('SE4')
  expect(eff.tariffs[0].name).toBe('home') // untouched fields preserved
  expect(eff.site.mainBreakerA).toBe(16)
  expect(base.tariffs[0].zone).toBe('SE3') // the base object is not mutated
})

test('setOverride with a new name appends a runtime-added entity', () => {
  const db = freshDb()
  setOverride(db, 'vehicle', 'car2', {
    type: 'skoda',
    vin: 'B'.repeat(17),
    username: 'u2',
    password: 'p2',
  })
  expect(getEffectiveConfig(base, db).vehicles.map((v) => v.name)).toEqual(['car', 'car2'])
})

test('getOverride / listOverrides / deleteOverride round-trip', () => {
  const db = freshDb()
  setOverride(db, 'tariff', 'home', { zone: 'SE4' })
  expect(getOverride(db, 'tariff', 'home')).toEqual({ zone: 'SE4' })
  expect(listOverrides(db)).toEqual([{ kind: 'tariff', name: 'home', patch: { zone: 'SE4' } }])
  expect(deleteOverride(db, 'tariff', 'home')).toBe(true)
  expect(getOverride(db, 'tariff', 'home')).toBeUndefined()
  expect(getEffectiveConfig(base, db).tariffs[0].zone).toBe('SE3') // back to base
})

test('an invalid override throws through the schema rather than half-applying', () => {
  const db = freshDb()
  setOverride(db, 'site', 'site', { mainBreakerA: -5 }) // must be positive
  expect(() => getEffectiveConfig(base, db)).toThrow()
})

test('setOverride merges into an existing override (partial updates compose)', () => {
  const db = freshDb()
  setOverride(db, 'charger', 'garage', { type: 'ocpp16', stationId: 'ST1' })
  setOverride(db, 'charger', 'garage', { maxA: 20 }) // partial — must keep type/stationId
  expect(getOverride(db, 'charger', 'garage')).toEqual({
    type: 'ocpp16',
    stationId: 'ST1',
    maxA: 20,
  })
})

test('applyConfigOverrides clears file-defined overrides, preserves runtime-added (prune clears all)', () => {
  const db = freshDb()
  setOverride(db, 'tariff', 'home', { zone: 'SE4' }) // 'home' is in base → file-defined
  setOverride(db, 'vehicle', 'newcar', {
    type: 'skoda',
    vin: 'C'.repeat(17),
    username: 'u',
    password: 'p',
  }) // not in base → runtime-added
  const { cleared, preserved } = applyConfigOverrides(base, db)
  expect(cleared.map((o) => o.name)).toEqual(['home'])
  expect(preserved.map((o) => o.name)).toEqual(['newcar'])
  expect(getOverride(db, 'tariff', 'home')).toBeUndefined() // reverted to osc.yaml
  expect(getOverride(db, 'vehicle', 'newcar')).toBeDefined() // kept

  applyConfigOverrides(base, db, { prune: true })
  expect(getOverride(db, 'vehicle', 'newcar')).toBeUndefined() // prune clears runtime-added too
})
