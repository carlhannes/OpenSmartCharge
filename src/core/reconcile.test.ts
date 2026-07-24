import { test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { configSchema, type Config } from './config.js'
import { setOverride } from './config-overrides.js'
import { createEventBus } from './events.js'
import { createReconciler, type ReconcileDeps } from './reconcile.js'
import { registerTariff, registerVehicle } from '../sdk/registry-api.js'
import type { ModuleCtx } from '../sdk/types.js'
import type { Tariff } from '../sdk/tariff.js'
import type { Vehicle } from '../sdk/vehicle.js'

// Fake modules record start/stop into `calls` so we can assert build-then-commit ordering without a
// real OCPP/tariff/vehicle backend. Unique type names → no collision with the real registry.
const calls: string[] = []
registerTariff({
  type: 'fake-tariff',
  create: (cfg) => {
    const id = (cfg as { name: string }).name
    return {
      start: async () => void calls.push(`tariff:${id}.start`),
      stop: async () => void calls.push(`tariff:${id}.stop`),
      health: () => 'ok',
      prices: async () => [],
    } as unknown as Tariff
  },
})
registerVehicle({
  type: 'fake-vehicle',
  label: 'Fake',
  configFields: [],
  capabilities: {
    soc: false,
    range: false,
    capacity: false,
    presence: false,
    climate: false,
    targetSoc: false,
  },
  create: (cfg) => {
    const id = (cfg as { name: string }).name
    calls.push(`vehicle:${id}.create`)
    return {
      stop: async () => void calls.push(`vehicle:${id}.stop`),
      health: () => 'ok',
    } as unknown as Vehicle
  },
})

const fakeLog = {
  info() {},
  warn() {},
  debug() {},
  error() {},
  trace() {},
  fatal() {},
  child() {
    return fakeLog
  },
}

const dirs: string[] = []
afterEach(() => {
  calls.length = 0
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(base: Config) {
  const dir = mkdtempSync(join(tmpdir(), 'osc-reconcile-'))
  dirs.push(dir)
  const db = openDb(dir)
  const events = createEventBus()
  const changed: { kind: string; name: string }[] = []
  events.on('config.changed', (p) => changed.push(p as { kind: string; name: string }))
  // The live config is a deep copy of the seed; reconcile must mutate THIS object in place.
  const config = configSchema.parse(JSON.parse(JSON.stringify(base))) as Config
  const rebuilds = { n: 0 }
  const deps: ReconcileDeps = {
    base,
    config,
    db,
    ctx: { db, events, log: fakeLog, fetch: globalThis.fetch } as unknown as ModuleCtx,
    events,
    health: new Map(),
    chargers: new Map(),
    tariffs: new Map(),
    meterReaders: new Map(),
    vehicles: new Map(),
    balancers: new Map(),
    loadpointStates: new Map(),
    chargerLimitMap: new Map(),
    chargerUnsubs: new Map(),
    wireChargerStatus: () => {},
    rebuildCircuits: () => void rebuilds.n++,
  }
  return { db, events, config, deps, changed, rebuilds }
}

test('reloadTariff: builds+starts new BEFORE stopping old, mutates config in place, emits config.changed', async () => {
  const base = configSchema.parse({
    tariffs: [{ name: 'home', type: 'fake-tariff', zone: 'SE1' }],
  }) as Config
  const { deps, config, changed } = setup(base)
  const old = {
    start: async () => {},
    stop: async () => void calls.push('tariff:home.OLD.stop'),
    health: () => 'ok',
    prices: async () => [],
  } as unknown as Tariff
  deps.tariffs.set('home', old)
  const arrRef = config.tariffs // for the mutate-in-place check
  setOverride(deps.db, 'tariff', 'home', { zone: 'SE4' })

  await createReconciler(deps).reloadTariff('home')

  // build-then-commit: the new module is started before the old is torn down, so a failed build
  // never leaves the circuit without a running module.
  expect(calls).toEqual(['tariff:home.start', 'tariff:home.OLD.stop'])
  expect(deps.tariffs.get('home')).not.toBe(old) // Map swapped to the new instance
  // config mutated IN PLACE (same array reference) and now carries the override.
  expect(config.tariffs).toBe(arrRef)
  expect(config.tariffs[0]).toMatchObject({ name: 'home', zone: 'SE4' })
  expect(changed).toContainEqual({ kind: 'tariff', name: 'home' })
})

test('addVehicle registers without start(); removeVehicle stops it, drops bindings, emits both', async () => {
  const base = configSchema.parse({
    vehicles: [
      { name: 'ev', type: 'fake-vehicle', vin: 'A'.repeat(17), username: 'u', password: 'p' },
    ],
    chargers: [{ name: 'g', type: 'ocpp16', stationId: 'S1' }],
    loadpoints: [{ name: 'g', charger: 'g', vehicle: 'ev' }],
  }) as Config
  const { deps, config, changed } = setup(base)
  const reconciler = createReconciler(deps)

  await reconciler.addVehicle('ev')
  expect(deps.vehicles.has('ev')).toBe(true)
  expect(deps.health.has('ev')).toBe(true)
  expect(calls).toEqual(['vehicle:ev.create']) // built, but vehicles own no timer — no start()
  expect(changed).toContainEqual({ kind: 'vehicle', name: 'ev' })

  await reconciler.removeVehicle('ev')
  expect(deps.vehicles.has('ev')).toBe(false)
  expect(deps.health.has('ev')).toBe(false)
  expect(calls).toEqual(['vehicle:ev.create', 'vehicle:ev.stop']) // stopped on remove
  // The loadpoint's binding to the removed vehicle is dropped in place (degrades to no-SoC).
  expect(config.loadpoints.find((l) => l.name === 'g')?.vehicle).toBeUndefined()
  expect(changed.filter((c) => c.kind === 'vehicle')).toHaveLength(2)
})

test('reloadVehicle rebuilds the handle (build-new → stop-old) and emits config.changed', async () => {
  const base = configSchema.parse({
    vehicles: [
      { name: 'ev', type: 'fake-vehicle', vin: 'A'.repeat(17), username: 'u', password: 'p' },
    ],
  }) as Config
  const { deps, changed } = setup(base)
  const reconciler = createReconciler(deps)

  await reconciler.addVehicle('ev')
  const first = deps.vehicles.get('ev')
  calls.length = 0

  await reconciler.reloadVehicle('ev')
  // A fresh handle is built BEFORE the old one is stopped (so a bad config never strands the vehicle).
  expect(calls).toEqual(['vehicle:ev.create', 'vehicle:ev.stop'])
  expect(deps.vehicles.get('ev')).not.toBe(first) // swapped to the new handle
  expect(changed.filter((c) => c.kind === 'vehicle')).toHaveLength(2) // add + reload
})

test('add/removeLoadpoint: seeds then drops runtime state, rebuilds circuits, emits config.changed', () => {
  const base = configSchema.parse({
    chargers: [{ name: 'g', type: 'ocpp16', stationId: 'S1' }],
    loadpoints: [{ name: 'g', charger: 'g' }],
  }) as Config
  const { deps, config, changed, rebuilds } = setup(base)
  const reconciler = createReconciler(deps)
  config.loadpoints.length = 0 // simulate "not yet in the live config" (a runtime add)

  reconciler.addLoadpoint('g')
  expect(deps.loadpointStates.has('g')).toBe(true) // runtime state seeded + adopted
  expect(config.loadpoints.map((l) => l.name)).toEqual(['g']) // appended in place
  expect(rebuilds.n).toBe(1) // circuits rebuilt so the control loop sees the new loadpoint
  expect(changed).toContainEqual({ kind: 'loadpoint', name: 'g' })

  reconciler.removeLoadpoint('g')
  expect(deps.loadpointStates.has('g')).toBe(false) // state dropped
  expect(config.loadpoints).toHaveLength(0) // spliced in place
  expect(rebuilds.n).toBe(2)
  expect(changed.filter((c) => c.kind === 'loadpoint')).toHaveLength(2)
})
