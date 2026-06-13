import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateSoc } from './estimator.js'
import { DEFAULT_CHARGING_EFFICIENCY } from './electrical.js'

// estimateSoc is the Tier-2 degradation path: it estimates SoC from delivered
// session energy when the live vehicle API is unavailable.

test('returns undefined when battery capacity is unknown', () => {
  assert.equal(estimateSoc(50, 10, undefined), undefined)
})

test('returns undefined when battery capacity is zero or negative', () => {
  assert.equal(estimateSoc(50, 10, 0), undefined)
  assert.equal(estimateSoc(50, 10, -5), undefined)
})

test('adds delivered energy to the last known SoC using the default efficiency', () => {
  const soc = estimateSoc(40, 10, 77)
  assert.ok(soc !== undefined)
  // Mirror the formula independently to guard the shared-constant refactor.
  const expected = 40 + (10 * DEFAULT_CHARGING_EFFICIENCY * 100) / 77
  assert.equal(soc, expected)
})

test('clamps the result at 100%', () => {
  assert.equal(estimateSoc(95, 100, 60), 100)
})

test('lower efficiency yields a lower estimate', () => {
  const lossy = estimateSoc(40, 10, 77, 0.8)
  const efficient = estimateSoc(40, 10, 77, 1.0)
  assert.ok(lossy !== undefined && efficient !== undefined)
  assert.ok(lossy < efficient)
})
