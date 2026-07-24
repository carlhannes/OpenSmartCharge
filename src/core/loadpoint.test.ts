import { test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import {
  loadLoadpointStates,
  foldChargerStatus,
  setLoadpointTarget,
  setLoadpointMode,
  setLoadpointVehicleOverride,
  applyConfigToLoadpoints,
  type LoadpointLiveFields,
} from './loadpoint.js'
import type { ChargerStatus } from '../sdk/charger.js'

test('defaultMode seeds a new loadpoint; a persisted mode wins on restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lp-'))
  const db = openDb(dir)
  try {
    // First boot: the configured defaultMode is honored (not hardcoded 'smart').
    let states = loadLoadpointStates(db, [{ name: 'lp', defaultMode: 'disabled' }])
    expect(states.get('lp')?.mode).toBe('disabled')

    // Restart with a different defaultMode must NOT override the persisted mode.
    states = loadLoadpointStates(db, [{ name: 'lp', defaultMode: 'fast' }])
    expect(states.get('lp')?.mode).toBe('disabled')

    // No defaultMode → still defaults to 'smart'.
    states = loadLoadpointStates(db, [{ name: 'other' }])
    expect(states.get('other')?.mode).toBe('smart')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foldChargerStatus keeps live current+power across bare status frames, clears them when not charging', () => {
  const status = (over: Partial<ChargerStatus>): ChargerStatus => ({
    connectorId: 1,
    status: 'Charging',
    connected: true,
    charging: true,
    ...over,
  })
  let live: LoadpointLiveFields = {
    connected: false,
    charging: false,
    currentA: 0,
    powerW: 0,
    sessionEnergyKWh: 0,
  }

  // MeterValues while charging → live current + power + energy recorded, and the raw OCPP status is
  // carried through (the SessionReconciler needs it — connected/charging booleans are too coarse).
  live = foldChargerStatus(live, status({ currentA: 9.7, powerW: 6600, sessionEnergyKWh: 0.1 }))
  expect(live.currentA).toBe(9.7)
  expect(live.powerW).toBe(6600)
  expect(live.sessionEnergyKWh).toBe(0.1)
  expect(live.status).toBe('Charging')

  // Bare StatusNotification (still charging, no currentA/powerW/energy) → last readings retained,
  // not blanked between meter frames.
  live = foldChargerStatus(live, status({}))
  expect(live.currentA).toBe(9.7)
  expect(live.powerW).toBe(6600)
  expect(live.sessionEnergyKWh).toBe(0.1)

  // StopTransaction pushes charging:false with no currentA/powerW → both must clear to 0
  // (the stale-"9.7 A after stop" bug), even though they're absent from the update.
  live = foldChargerStatus(
    live,
    status({ status: 'Finishing', charging: false, sessionEnergyKWh: 0 }),
  )
  expect(live.charging).toBe(false)
  expect(live.currentA).toBe(0)
  expect(live.powerW).toBe(0)

  // Idle/unplugged (Available) also draws nothing. (Note: SuspendedEV/EVSE map to
  // charging:true — a suspended session still flows MeterValues that self-correct the reading,
  // so the clear-to-0 rule keys off the charging flag, not the status label.)
  live = foldChargerStatus(live, status({ status: 'Available', connected: false, charging: false }))
  expect(live.currentA).toBe(0)
  expect(live.powerW).toBe(0)
})

test('config targets (soc/time/kWh) seed a new loadpoint; persisted targets survive restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lp-'))
  const db = openDb(dir)
  try {
    // First boot: config targets are seeded into the new row (previously they never reached the DB).
    let states = loadLoadpointStates(db, [
      { name: 'lp', defaultMode: 'smart', targetSoc: 80, targetTime: '07:00', targetKWh: 40 },
    ])
    let s = states.get('lp')!
    expect(s.targetSoc).toBe(80)
    expect(s.targetTime).toBe('07:00')
    expect(s.targetKWh).toBe(40)

    // Restart with different config targets must NOT override the persisted ones.
    states = loadLoadpointStates(db, [
      { name: 'lp', defaultMode: 'smart', targetSoc: 50, targetTime: '09:00', targetKWh: 20 },
    ])
    s = states.get('lp')!
    expect(s.targetSoc).toBe(80)
    expect(s.targetTime).toBe('07:00')
    expect(s.targetKWh).toBe(40)

    // No config targets → nulls seeded → undefined in state.
    states = loadLoadpointStates(db, [{ name: 'bare' }])
    s = states.get('bare')!
    expect(s.targetSoc).toBeUndefined()
    expect(s.targetKWh).toBeUndefined()
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setLoadpointTarget partial update leaves the other targets unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lp-'))
  const db = openDb(dir)
  try {
    loadLoadpointStates(db, [
      { name: 'lp', defaultMode: 'smart', targetSoc: 80, targetTime: '07:00', targetKWh: 40 },
    ])
    // Update only targetSoc — targetTime/targetKWh must survive (they were NULLed before the fix).
    setLoadpointTarget(db, 'lp', 55, undefined, undefined)
    const row = db
      .prepare('SELECT target_soc, target_time, target_kwh FROM loadpoint_state WHERE name = ?')
      .get('lp') as { target_soc: number; target_time: string; target_kwh: number }
    expect(row.target_soc).toBe(55)
    expect(row.target_time).toBe('07:00')
    expect(row.target_kwh).toBe(40)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyConfigToLoadpoints declaratively overwrites persisted mode + targets from config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lp-'))
  const db = openDb(dir)
  try {
    // Seed, then diverge the DB from config the way runtime UI/API changes would.
    loadLoadpointStates(db, [{ name: 'lp', defaultMode: 'disabled', targetSoc: 80, targetKWh: 40 }])
    setLoadpointMode(db, 'lp', 'fast')
    setLoadpointTarget(db, 'lp', 55, undefined, undefined)
    // Declaratively re-apply config: the DB must match the file again (overwrite, not merge).
    applyConfigToLoadpoints(db, [
      { name: 'lp', defaultMode: 'smart', targetSoc: 70, targetTime: '06:00' },
    ])
    const row = db
      .prepare(
        'SELECT mode, target_soc, target_time, target_kwh FROM loadpoint_state WHERE name = ?',
      )
      .get('lp') as {
      mode: string
      target_soc: number | null
      target_time: string | null
      target_kwh: number | null
    }
    expect(row.mode).toBe('smart')
    expect(row.target_soc).toBe(70)
    expect(row.target_time).toBe('06:00')
    expect(row.target_kwh).toBeNull() // omitted in config → cleared (declarative, unlike a partial update)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('minSoc: seeded from config, partial-updated independently, and declaratively applied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lp-'))
  const db = openDb(dir)
  try {
    expect(loadLoadpointStates(db, [{ name: 'lp', minSoc: 20 }]).get('lp')?.minSoc).toBe(20)
    // minSoc and the charge targets update independently (COALESCE partial writes).
    setLoadpointTarget(db, 'lp', 80, undefined, undefined, undefined) // soc only
    setLoadpointTarget(db, 'lp', undefined, undefined, undefined, 30) // minSoc only
    const row = db
      .prepare('SELECT target_soc, min_soc FROM loadpoint_state WHERE name = ?')
      .get('lp') as { target_soc: number; min_soc: number }
    expect(row).toMatchObject({ target_soc: 80, min_soc: 30 }) // neither wiped the other
    // config:apply overwrites minSoc declaratively.
    applyConfigToLoadpoints(db, [{ name: 'lp', minSoc: 15 }])
    expect(
      (
        db.prepare('SELECT min_soc FROM loadpoint_state WHERE name = ?').get('lp') as {
          min_soc: number
        }
      ).min_soc,
    ).toBe(15)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setLoadpointTarget clears target_kwh with null, leaving other targets intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lp-'))
  const db = openDb(dir)
  try {
    loadLoadpointStates(db, [{ name: 'lp', targetSoc: 75, targetKWh: 40 }])
    // null CLEARS the kWh cap (guest "just charge"); undefined would leave it (COALESCE).
    setLoadpointTarget(db, 'lp', undefined, undefined, null)
    const row = db
      .prepare('SELECT target_soc, target_kwh FROM loadpoint_state WHERE name = ?')
      .get('lp') as { target_soc: number; target_kwh: number | null }
    expect(row.target_kwh).toBeNull() // cleared
    expect(row.target_soc).toBe(75) // untouched
    expect(loadLoadpointStates(db, [{ name: 'lp' }]).get('lp')?.targetKWh).toBeUndefined()
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vehicle override persists, reads back a name or guest, and clears to auto', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lp-'))
  const db = openDb(dir)
  const ov = () => loadLoadpointStates(db, [{ name: 'lp' }]).get('lp')?.vehicleOverride
  try {
    loadLoadpointStates(db, [{ name: 'lp' }])
    expect(ov()).toBeUndefined() // default = auto-detect
    setLoadpointVehicleOverride(db, 'lp', 'guest')
    expect(ov()).toBe('guest')
    setLoadpointVehicleOverride(db, 'lp', 'enyaq') // a specific vehicle name (sticky)
    expect(ov()).toBe('enyaq')
    setLoadpointVehicleOverride(db, 'lp', null) // back to auto
    expect(ov()).toBeUndefined()
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
