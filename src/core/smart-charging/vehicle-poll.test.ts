import { test, expect } from 'vitest'
import { shouldPollVehicle, type VehiclePollInput } from './vehicle-poll.js'

// The lifecycle owns WHEN to poll a vehicle; this pure gate encodes the policy: poll on
// (re)connect + periodically while charging, never while idle or disconnected — polling MySkoda
// too often can wake/drain the car and risk an account lockout.

const base: VehiclePollInput = {
  now: 1_000_000,
  connected: true,
  charging: false,
  lastPollAt: 0,
  intervalMs: 30 * 60_000, // 30 min
  polledThisConnection: true,
}

test('disconnected → never poll (nothing plugged in)', () => {
  expect(shouldPollVehicle({ ...base, connected: false, polledThisConnection: false })).toBe(false)
  expect(shouldPollVehicle({ ...base, connected: false, charging: true })).toBe(false)
})

test('first poll on (re)connect → poll to anchor SoC/range', () => {
  expect(shouldPollVehicle({ ...base, polledThisConnection: false, charging: false })).toBe(true)
})

test('charging + interval elapsed → re-anchor', () => {
  const now = base.lastPollAt + base.intervalMs // exactly one interval later
  expect(shouldPollVehicle({ ...base, charging: true, lastPollAt: 0, now })).toBe(true)
  expect(shouldPollVehicle({ ...base, charging: true, lastPollAt: 0, now: now + 1 })).toBe(true)
})

test('charging + too soon → do not wake the car', () => {
  const now = base.lastPollAt + base.intervalMs - 1 // one ms short of the interval
  expect(shouldPollVehicle({ ...base, charging: true, lastPollAt: 0, now })).toBe(false)
})

test('connected + idle (not charging), already polled → do not poll', () => {
  // The idle case: cable plugged, car not drawing — we already anchored on connect, so stay quiet
  // no matter how much wall-clock has passed (only charging drives periodic re-anchoring).
  expect(
    shouldPollVehicle({ ...base, charging: false, now: base.now + 10 * base.intervalMs }),
  ).toBe(false)
})
