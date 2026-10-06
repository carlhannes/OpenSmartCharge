import { test, expect } from 'vitest'
import {
  shouldPollVehicle,
  vehiclesToResetOnUnplug,
  type VehiclePollInput,
} from './vehicle-poll.js'

// The lifecycle owns WHEN to poll a vehicle; this pure gate encodes the policy: poll on (re)connect,
// then on two cadences while plugged in — slow while actively drawing (re-anchor the estimate),
// faster while connected-but-idle (catch climate/plug changes). Never while unplugged.

const base: VehiclePollInput = {
  now: 1_000_000,
  connected: true,
  drawing: false,
  lastPollAt: 0,
  chargingIntervalMs: 30 * 60_000, // 30 min while drawing
  idleIntervalMs: 5 * 60_000, // 5 min while connected-but-idle
  polledThisConnection: true,
}

test('unplugged → never poll (do not wake a parked car)', () => {
  expect(shouldPollVehicle({ ...base, connected: false, polledThisConnection: false })).toBe(false)
  expect(shouldPollVehicle({ ...base, connected: false, drawing: true })).toBe(false)
})

test('first poll on (re)connect → anchor SoC/range', () => {
  expect(shouldPollVehicle({ ...base, polledThisConnection: false })).toBe(true)
})

test('drawing → re-anchor on the (slow) charging interval, not before', () => {
  const iv = base.chargingIntervalMs
  expect(shouldPollVehicle({ ...base, drawing: true, lastPollAt: 0, now: iv })).toBe(true)
  expect(shouldPollVehicle({ ...base, drawing: true, lastPollAt: 0, now: iv - 1 })).toBe(false)
})

test('connected + idle → poll on the (faster) idle interval to catch climate/plug changes', () => {
  const iv = base.idleIntervalMs
  expect(shouldPollVehicle({ ...base, drawing: false, lastPollAt: 0, now: iv })).toBe(true)
  expect(shouldPollVehicle({ ...base, drawing: false, lastPollAt: 0, now: iv - 1 })).toBe(false)
  // idle interval is shorter than the charging one → an idle car polls while a drawing one still waits
  const between = base.idleIntervalMs + 1
  expect(shouldPollVehicle({ ...base, drawing: false, lastPollAt: 0, now: between })).toBe(true)
  expect(shouldPollVehicle({ ...base, drawing: true, lastPollAt: 0, now: between })).toBe(false)
})

test('vehiclesToResetOnUnplug: only on the unplug edge, and never a car in use on another loadpoint', () => {
  const base = { candidates: ['enyaq', 'opel'], inUseElsewhere: new Set<string>() }
  // the connected→unplugged edge resets every candidate
  expect(vehiclesToResetOnUnplug({ ...base, wasConnected: true, connected: false })).toEqual([
    'enyaq',
    'opel',
  ])
  // staying unplugged (every later tick) resets nothing — the old behaviour reset on each tick
  expect(vehiclesToResetOnUnplug({ ...base, wasConnected: false, connected: false })).toEqual([])
  // still plugged in → nothing
  expect(vehiclesToResetOnUnplug({ ...base, wasConnected: true, connected: true })).toEqual([])
  // a car charging on another loadpoint keeps its poll state (no forced re-poll, backoff intact)
  expect(
    vehiclesToResetOnUnplug({
      ...base,
      wasConnected: true,
      connected: false,
      inUseElsewhere: new Set(['enyaq']),
    }),
  ).toEqual(['opel'])
})
