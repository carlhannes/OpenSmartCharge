import { test, expect } from 'vitest'
import { parse } from 'yaml'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { configSchema } from './config.js'
import { getEffectiveConfig } from './config-overrides.js'
import {
  buildConfigExport,
  serializeConfig,
  importConfig,
  REDACTED,
  type LoadpointRuntime,
} from './config-io.js'

const state = (m: Record<string, LoadpointRuntime>) => new Map(Object.entries(m))

// A throwaway DB + the defaults base — importConfig lives in the post-rebase world where the base is
// all-defaults and the DB carries the whole config.
function withDb(
  fn: (db: ReturnType<typeof openDb>, base: ReturnType<typeof configSchema.parse>) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), 'osc-cfgio-'))
  const db = openDb(dir)
  try {
    fn(db, configSchema.parse({}))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
const pw = (v: unknown): string | undefined => (v as { password?: string }).password

test('export includes only non-default singleton fields + all entities, with live loadpoint mode/targets', () => {
  const effective = configSchema.parse({
    site: { mainBreakerA: 16 },
    smartCharging: { reserveA: 2 },
    vehicles: [{ name: 'enyaq', type: 'skoda', username: 'u', password: 'secret' }],
    chargers: [{ name: 'zaptec', type: 'ocpp16', stationId: 'ZAP1' }],
    loadpoints: [{ name: 'garage', charger: 'zaptec', vehicle: 'enyaq', defaultMode: 'disabled' }],
  })
  const doc = buildConfigExport({
    effective,
    loadpointState: state({ garage: { mode: 'smart', targetSoc: 75 } }),
    timezone: 'Europe/Stockholm', // == default → omitted
    logRetentionDays: 3, // == default → omitted
    secrets: false,
  })

  // site: only the non-default scalar; name/port/timezone (all defaults) dropped
  expect(doc.site).toEqual({ mainBreakerA: 16 })
  // smartCharging: only reserveA — the ~dozen defaulted knobs are omitted
  expect(doc.smartCharging).toEqual({ reserveA: 2 })
  // entity exported whole
  expect(doc.chargers).toEqual([{ name: 'zaptec', type: 'ocpp16', stationId: 'ZAP1' }])
  // loadpoint carries the LIVE mode (smart, not the 'off' seed) + live target
  expect(doc.loadpoints).toEqual([
    { name: 'garage', charger: 'zaptec', vehicle: 'enyaq', defaultMode: 'smart', targetSoc: 75 },
  ])
  // credential redacted, non-secret field intact
  expect((doc.vehicles as [{ password: string; username: string }])[0].password).toBe(REDACTED)
  expect((doc.vehicles as [{ username: string }])[0].username).toBe('u')
  // defaulted runtime settings omitted
  expect(doc.logs).toBeUndefined()
})

test('export ?secrets=1 keeps plaintext credentials', () => {
  const effective = configSchema.parse({
    vehicles: [{ name: 'enyaq', type: 'skoda', password: 'secret' }],
  })
  const doc = buildConfigExport({
    effective,
    loadpointState: state({}),
    timezone: 'Europe/Stockholm',
    logRetentionDays: 3,
    secrets: true,
  })
  expect((doc.vehicles as [{ password: string }])[0].password).toBe('secret')
})

test('all-default config exports (almost) nothing, and non-default timezone/retention surface', () => {
  const bare = buildConfigExport({
    effective: configSchema.parse({}),
    loadpointState: state({}),
    timezone: 'Europe/Stockholm',
    logRetentionDays: 3,
    secrets: false,
  })
  expect(bare.site).toBeUndefined()
  expect(bare.smartCharging).toBeUndefined()
  expect(bare.mqttBridge).toBeUndefined()

  const withRuntime = buildConfigExport({
    effective: configSchema.parse({}),
    loadpointState: state({}),
    timezone: 'America/New_York',
    logRetentionDays: 7,
    secrets: false,
  })
  expect(withRuntime.site).toEqual({ timezone: 'America/New_York' })
  expect(withRuntime.logs).toEqual({ retentionDays: 7 })
})

test('serialized export is valid YAML that parses back to the same document', () => {
  const doc = buildConfigExport({
    effective: configSchema.parse({
      site: { mainBreakerA: 16 },
      tariffs: [{ name: 'home', type: 'elpris', zone: 'SE4' }],
    }),
    loadpointState: state({}),
    timezone: 'Europe/Stockholm',
    logRetentionDays: 3,
    secrets: false,
  })
  expect(parse(serializeConfig(doc))).toEqual(doc)
})

test('import replace: writes the document and blanks everything else to defaults', () => {
  withDb((db, base) => {
    importConfig(
      db,
      {
        site: { mainBreakerA: 20 },
        smartCharging: { reserveA: 3 },
        vehicles: [{ name: 'old', type: 'skoda' }],
      },
      { mode: 'replace', currentEffective: base },
    )
    let eff = getEffectiveConfig(base, db)
    expect(eff.site.mainBreakerA).toBe(20)
    expect(eff.smartCharging.reserveA).toBe(3)
    expect(eff.vehicles.map((v) => v.name)).toEqual(['old'])

    // Replace with a document that omits the vehicle + reserveA → they revert to defaults.
    importConfig(db, { site: { mainBreakerA: 16 } }, { mode: 'replace', currentEffective: eff })
    eff = getEffectiveConfig(base, db)
    expect(eff.site.mainBreakerA).toBe(16)
    expect(eff.smartCharging.reserveA).toBe(base.smartCharging.reserveA)
    expect(eff.vehicles).toEqual([])
  })
})

test('import merge: only present sections change; the rest is untouched', () => {
  withDb((db, base) => {
    importConfig(
      db,
      { smartCharging: { reserveA: 3 }, vehicles: [{ name: 'old', type: 'skoda' }] },
      { mode: 'replace', currentEffective: base },
    )
    const seeded = getEffectiveConfig(base, db)
    importConfig(db, { site: { mainBreakerA: 16 } }, { mode: 'merge', currentEffective: seeded })
    const eff = getEffectiveConfig(base, db)
    expect(eff.site.mainBreakerA).toBe(16) // changed
    expect(eff.smartCharging.reserveA).toBe(3) // untouched
    expect(eff.vehicles.map((v) => v.name)).toEqual(['old']) // untouched
  })
})

test('import: a redacted credential keeps the existing secret (never clobbers)', () => {
  withDb((db, base) => {
    importConfig(
      db,
      { vehicles: [{ name: 'enyaq', type: 'skoda', password: 'real' }] },
      { mode: 'replace', currentEffective: base },
    )
    const seeded = getEffectiveConfig(base, db)
    expect(pw(seeded.vehicles[0])).toBe('real')

    importConfig(
      db,
      { vehicles: [{ name: 'enyaq', type: 'skoda', password: REDACTED }] },
      { mode: 'merge', currentEffective: seeded },
    )
    expect(pw(getEffectiveConfig(base, db).vehicles[0])).toBe('real')
  })
})

test('import dryRun validates without writing', () => {
  withDb((db, base) => {
    const before = getEffectiveConfig(base, db)
    const r = importConfig(
      db,
      { site: { mainBreakerA: 16 } },
      {
        mode: 'replace',
        currentEffective: base,
        dryRun: true,
      },
    )
    expect(r.dryRun).toBe(true)
    expect(r.sections).toEqual(['site'])
    expect(getEffectiveConfig(base, db)).toEqual(before) // nothing persisted
  })
})

test('import rejects an invalid config without writing anything', () => {
  withDb((db, base) => {
    importConfig(db, { site: { mainBreakerA: 16 } }, { mode: 'replace', currentEffective: base })
    const before = getEffectiveConfig(base, db)
    expect(() =>
      importConfig(
        db,
        { loadpoints: [{ name: 'x', charger: 'c', defaultMode: 'bogus' }] },
        { mode: 'merge', currentEffective: before },
      ),
    ).toThrow()
    expect(getEffectiveConfig(base, db)).toEqual(before) // validate-first → untouched
  })
})
