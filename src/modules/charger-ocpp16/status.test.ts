import { test, expect } from 'vitest'
import { computeConnectionState, shouldAutoStartTransaction, computeHealth } from './status.js'

// The 9 OCPP 1.6 connector statuses and their expected {charging, connected} mapping.
const CONNECTION_CASES: Array<[string, { charging: boolean; connected: boolean }]> = [
  ['Available', { charging: false, connected: false }],
  ['Preparing', { charging: false, connected: true }],
  ['Charging', { charging: true, connected: true }],
  ['SuspendedEVSE', { charging: true, connected: true }],
  ['SuspendedEV', { charging: true, connected: true }],
  ['Finishing', { charging: false, connected: true }],
  ['Reserved', { charging: false, connected: true }],
  ['Unavailable', { charging: false, connected: false }],
  ['Faulted', { charging: false, connected: false }],
]

for (const [status, expected] of CONNECTION_CASES) {
  test(`computeConnectionState: ${status} → ${JSON.stringify(expected)}`, () => {
    expect(computeConnectionState(status)).toEqual(expected)
  })
}

test('computeConnectionState: an unknown status counts as connected but not charging', () => {
  // Conservative default: not one of the idle/out-of-service states, so "vehicle present".
  expect(computeConnectionState('SomethingNew')).toEqual({ charging: false, connected: true })
})

test('shouldAutoStartTransaction: Preparing + no active tx + enabled + not-yet-started → true', () => {
  expect(shouldAutoStartTransaction('Preparing', false, true, false)).toBe(true)
})

test('shouldAutoStartTransaction: disabled → false', () => {
  expect(shouldAutoStartTransaction('Preparing', false, false, false)).toBe(false)
})

test('shouldAutoStartTransaction: a transaction is already active → false', () => {
  expect(shouldAutoStartTransaction('Preparing', true, true, false)).toBe(false)
})

test('shouldAutoStartTransaction: already auto-started this plug-in → false (no re-churn on a full car)', () => {
  expect(shouldAutoStartTransaction('Preparing', false, true, true)).toBe(false)
})

test('shouldAutoStartTransaction: non-Preparing status → false', () => {
  expect(shouldAutoStartTransaction('Charging', false, true, false)).toBe(false)
  expect(shouldAutoStartTransaction('Available', false, true, false)).toBe(false)
})

test('computeHealth: no registered stations → ok', () => {
  expect(computeHealth(0, 0)).toBe('ok')
})

test('computeHealth: registered but none connected → unavailable', () => {
  expect(computeHealth(2, 0)).toBe('unavailable')
})

test('computeHealth: some of the registered stations connected → degraded', () => {
  expect(computeHealth(2, 1)).toBe('degraded')
})

test('computeHealth: all registered stations connected → ok', () => {
  expect(computeHealth(2, 2)).toBe('ok')
  expect(computeHealth(1, 1)).toBe('ok')
})
