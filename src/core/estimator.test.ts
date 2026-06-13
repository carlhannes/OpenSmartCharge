import { test, expect } from 'vitest'
import { estimateSoc } from './estimator.js'
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
