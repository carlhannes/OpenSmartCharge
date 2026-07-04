import { test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { loadLoadpointStates, foldChargerStatus, type LoadpointLiveFields } from './loadpoint.js'
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

test('foldChargerStatus keeps live current across bare status frames, clears it when not charging', () => {
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
    sessionEnergyKWh: 0,
  }

  // MeterValues while charging → live current + energy recorded.
  live = foldChargerStatus(live, status({ currentA: 9.7, sessionEnergyKWh: 0.1 }))
  expect(live.currentA).toBe(9.7)
  expect(live.sessionEnergyKWh).toBe(0.1)

  // Bare StatusNotification (still charging, no currentA/energy) → last readings retained,
  // not blanked between meter frames.
  live = foldChargerStatus(live, status({}))
  expect(live.currentA).toBe(9.7)
  expect(live.sessionEnergyKWh).toBe(0.1)

  // StopTransaction pushes charging:false with no currentA → current must clear to 0
  // (the stale-"9.7 A after stop" bug), even though currentA is absent from the update.
  live = foldChargerStatus(
    live,
    status({ status: 'Finishing', charging: false, sessionEnergyKWh: 0 }),
  )
  expect(live.charging).toBe(false)
  expect(live.currentA).toBe(0)

  // Idle/unplugged (Available) also draws no current. (Note: SuspendedEV/EVSE map to
  // charging:true — a suspended session still flows MeterValues that self-correct the reading,
  // so the clear-to-0 rule keys off the charging flag, not the status label.)
  live = foldChargerStatus(live, status({ status: 'Available', connected: false, charging: false }))
  expect(live.currentA).toBe(0)
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
