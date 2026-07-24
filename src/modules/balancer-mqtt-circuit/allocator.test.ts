import { test, expect } from 'vitest'
import { allocate } from './allocator.js'
import type { LoadpointSnapshot } from '../../sdk/balancer.js'

function lp(
  overrides: Partial<LoadpointSnapshot> & Pick<LoadpointSnapshot, 'id' | 'mode'>,
): LoadpointSnapshot {
  return {
    connected: true,
    charging: true,
    currentA: 0,
    commandedA: 0,
    sessionEnergyKWh: 0,
    pricesAvailable: true,
    maxCurrentA: 16,
    shouldChargeNow: true,
    ...overrides,
  }
}

// The allocator is a PURE splitter of the circuit budget the lifecycle already resolved through the
// degradation ladder — tests pass `circuitBudgetA` directly (no meter reading, no staleness here).
// The live-meter headroom + charger credit-back that used to live here now live in the resolver /
// circuitOwnDrawA and are covered by control-loop.test.ts.

test('disabled loadpoint always gets 0', () => {
  const { allocations } = allocate({
    loadpoints: [lp({ id: 'a', mode: 'disabled', currentA: 10, commandedA: 10 })],
    circuitBudgetA: 17,
  })
  expect(allocations.get('a')).toBe(0)
})

test('smart with shouldChargeNow=false gets 0', () => {
  const { allocations } = allocate({
    loadpoints: [lp({ id: 'a', mode: 'smart', shouldChargeNow: false })],
    circuitBudgetA: 17,
  })
  expect(allocations.get('a')).toBe(0)
})

test('fast loadpoint takes up to its ceiling from the budget', () => {
  const { allocations } = allocate({
    loadpoints: [lp({ id: 'a', mode: 'fast', currentA: 16, commandedA: 16 })],
    circuitBudgetA: 17,
  })
  expect(allocations.get('a')).toBe(16) // min(maxCurrentA 16, budget 17)
})

test('budget below the 6A floor rounds to 0 (fast and smart)', () => {
  expect(
    allocate({ loadpoints: [lp({ id: 'a', mode: 'fast' })], circuitBudgetA: 3 }).allocations.get(
      'a',
    ),
  ).toBe(0)
  expect(
    allocate({ loadpoints: [lp({ id: 'a', mode: 'smart' })], circuitBudgetA: 3 }).allocations.get(
      'a',
    ),
  ).toBe(0)
})

test('the split never exceeds the circuit budget', () => {
  const { allocations } = allocate({
    loadpoints: [lp({ id: 'a', mode: 'fast' }), lp({ id: 'b', mode: 'smart' })],
    circuitBudgetA: 16,
  })
  const total = (allocations.get('a') ?? 0) + (allocations.get('b') ?? 0)
  expect(total).toBeLessThanOrEqual(16)
})

test('fast gets priority when the budget only fits one', () => {
  const { allocations } = allocate({
    loadpoints: [lp({ id: 'smart1', mode: 'smart' }), lp({ id: 'fast1', mode: 'fast' })],
    circuitBudgetA: 10,
  })
  expect(allocations.get('fast1')).toBe(10) // min(16, 10)
  expect(allocations.get('smart1')).toBe(0) // remaining 0
})

test('fast takes its ceiling, smart gets the remainder', () => {
  const { allocations } = allocate({
    loadpoints: [
      lp({ id: 'smart1', mode: 'smart' }),
      lp({ id: 'fast1', mode: 'fast', maxCurrentA: 12 }),
    ],
    circuitBudgetA: 12,
  })
  expect(allocations.get('fast1')).toBe(12)
  expect(allocations.get('smart1')).toBe(0) // remaining 0 → sub-6A floor
})

test('hysteresis: allocation within ±1A of commandedA stays unchanged', () => {
  const { allocations } = allocate({
    loadpoints: [lp({ id: 'a', mode: 'fast', currentA: 9, commandedA: 9 })],
    circuitBudgetA: 8, // give=8; |8-9|=1 ≤ 1 → stays at 9
  })
  expect(allocations.get('a')).toBe(9)
})

test('hysteresis breach: allocation outside ±1A moves to the new value', () => {
  const { allocations } = allocate({
    loadpoints: [lp({ id: 'a', mode: 'fast', currentA: 9, commandedA: 9 })],
    circuitBudgetA: 6, // give=6; |6-9|=3 > 1 → moves to 6
  })
  expect(allocations.get('a')).toBe(6)
})
