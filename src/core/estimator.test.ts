import { test, expect } from 'vitest'
import { estimateSoc, estimateSocSinceAnchor, observedEfficiency } from './estimator.js'
import { DEFAULT_CHARGING_EFFICIENCY } from './electrical.js'

// estimateSoc is the Tier-2 degradation path: it estimates SoC from delivered
// session energy when the live vehicle API is unavailable.

test('returns undefined when battery capacity is unknown', () => {
  expect(estimateSoc(50, 10, undefined)).toBeUndefined()
})

test('returns undefined when battery capacity is zero or negative', () => {
  expect(estimateSoc(50, 10, 0)).toBeUndefined()
  expect(estimateSoc(50, 10, -5)).toBeUndefined()
})

test('adds delivered energy to the last known SoC using the default efficiency', () => {
  const soc = estimateSoc(40, 10, 77)
  expect(soc).toBeDefined()
  // Mirror the formula independently to guard the shared-constant refactor.
  const expected = 40 + (10 * DEFAULT_CHARGING_EFFICIENCY * 100) / 77
  expect(soc).toBe(expected)
})

test('clamps the result at 100%', () => {
  expect(estimateSoc(95, 100, 60)).toBe(100)
})

test('lower efficiency yields a lower estimate', () => {
  const lossy = estimateSoc(40, 10, 77, 0.8)
  const efficient = estimateSoc(40, 10, 77, 1.0)
  expect(lossy).toBeDefined()
  expect(efficient).toBeDefined()
  if (lossy !== undefined && efficient !== undefined) {
    expect(lossy).toBeLessThan(efficient)
  }
})

// estimateSocSinceAnchor is the re-anchor variant used between vehicle polls: it carries a real
// reading forward by ONLY the energy delivered since that reading — never the whole session.

test('carries forward only the energy delivered since the anchor (no double-count)', () => {
  // Anchor: 50% at 5 kWh into the session; now 15 kWh in → only the 10 kWh DELTA counts.
  const est = estimateSocSinceAnchor(50, 5, 15, 77)
  expect(est).toBe(estimateSoc(50, 10, 77))
  // The buggy old behaviour would have added the whole 15 kWh on top of the mid-session 50%.
  expect(est).not.toBe(estimateSoc(50, 15, 77))
})

test('anchored at session start behaves exactly like estimateSoc', () => {
  expect(estimateSocSinceAnchor(40, 0, 10, 77)).toBe(estimateSoc(40, 10, 77))
})

test('a session-energy decrease (meter reset) floors the delta at 0 — never subtracts SoC', () => {
  // sessionKWhNow < anchor: don't run the estimate backwards; hold at the anchor SoC.
  expect(estimateSocSinceAnchor(60, 20, 3, 77)).toBe(60)
})

test('returns undefined when capacity is unknown', () => {
  expect(estimateSocSinceAnchor(50, 5, 15, undefined)).toBeUndefined()
})

// observedEfficiency measures THIS session's real efficiency from two readings, so a mid-session
// car-API dropout can extrapolate SoC on the measured value instead of the generic constant.

test('observedEfficiency: battery kWh gained / grid kWh delivered, within a sane band', () => {
  // 40%→60% = 20% of 60 kWh = 12 kWh into the battery, for 13 kWh from the grid ⇒ ≈0.923.
  expect(
    observedEfficiency({ soc: 40, sessionKWh: 0 }, { soc: 60, sessionKWh: 13 }, 60),
  ).toBeCloseTo(12 / 13, 3)
})

test('observedEfficiency: undefined until enough SoC AND kWh delta to be reliable', () => {
  expect(
    observedEfficiency({ soc: 40, sessionKWh: 0 }, { soc: 60, sessionKWh: 2 }, 60),
  ).toBeUndefined() // <3 kWh
  expect(
    observedEfficiency({ soc: 40, sessionKWh: 0 }, { soc: 41, sessionKWh: 6 }, 60),
  ).toBeUndefined() // <2% SoC
})

test('observedEfficiency: rejects out-of-band results (noise / bad data)', () => {
  // 12 kWh into 12 kWh delivered ⇒ 1.0, impossible → undefined.
  expect(
    observedEfficiency({ soc: 40, sessionKWh: 0 }, { soc: 60, sessionKWh: 12 }, 60),
  ).toBeUndefined()
  // 6 kWh into 12 kWh ⇒ 0.5, implausibly low → undefined.
  expect(
    observedEfficiency({ soc: 40, sessionKWh: 0 }, { soc: 50, sessionKWh: 12 }, 60),
  ).toBeUndefined()
})

test('observedEfficiency: undefined without capacity', () => {
  expect(
    observedEfficiency({ soc: 40, sessionKWh: 0 }, { soc: 60, sessionKWh: 13 }, undefined),
  ).toBeUndefined()
})
