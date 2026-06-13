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

function input(overrides: {
  loadpoints: LoadpointSnapshot[]
  mainBreakerA?: number
  phaseCurrentsA?: { i1: number; i2: number; i3: number } | null
  meterStale?: boolean
  safeStaticCurrentA?: number
}) {
  return {
    mainBreakerA: 25,
    phaseCurrentsA: { i1: 8, i2: 0, i3: 0 },
    meterStale: false,
    safeStaticCurrentA: 10,
    ...overrides,
  }
}

test('disabled loadpoint always gets 0', () => {
  const { allocations } = allocate(
    input({ loadpoints: [lp({ id: 'a', mode: 'disabled', currentA: 10, commandedA: 10 })] }),
  )
  expect(allocations.get('a')).toBe(0)
})

test('smart with shouldChargeNow=false gets 0', () => {
  const { allocations } = allocate(
    input({
      loadpoints: [
        lp({ id: 'a', mode: 'smart', shouldChargeNow: false, currentA: 0, commandedA: 0 }),
      ],
    }),
  )
  expect(allocations.get('a')).toBe(0)
})

test('healthy steady-state: credit-back on commandedA keeps allocation stable', () => {
  // House: 8A, Charger: commanded 16A and fully ramped. Phase = 8 + 16 = 24A.
  // freeAmps = 25 - 24 + max(16,16) = 17; give = min(16, 17) = 16
  const { allocations, freeAmps } = allocate(
    input({
      loadpoints: [lp({ id: 'a', mode: 'fast', currentA: 16, commandedA: 16 })],
      phaseCurrentsA: { i1: 24, i2: 0, i3: 0 },
    }),
  )
  expect(allocations.get('a')).toBe(16)
  expect(freeAmps).toBeGreaterThanOrEqual(0)
})

test('ramp-up: commandedA prevents oscillation during car ramp', () => {
  // Car commanded 16A but still drawing 6A (ramping). Phase = 8A house + 6A charger = 14A.
  // Without fix: freeAmps = 25 - 14 + 6 = 17; give = 16 (ok, but only by coincidence)
  // With fix: freeAmps = 25 - 14 + max(6,16) = 27; give = min(16, 27) = 16 — same result here
  // Key scenario: breaker is smaller. Use mainBreakerA=20, phase=22, commanded=16, measured=6
  // Without fix: freeAmps = 20 - 22 + 6 = 4; give=4 → 0 (too low!) → oscillation
  // With fix:    freeAmps = 20 - 22 + 16 = 14; give=min(16,14)=14; |14-16|=2 > 1 → 14
  const { allocations } = allocate(
    input({
      loadpoints: [lp({ id: 'a', mode: 'fast', currentA: 6, commandedA: 16 })],
      mainBreakerA: 20,
      phaseCurrentsA: { i1: 22, i2: 0, i3: 0 },
    }),
  )
  // commandedA credit-back keeps the car going; without it, give=4 → IEC floor → 0
  expect(allocations.get('a') ?? 0).toBeGreaterThanOrEqual(6)
})

test('fast 6A floor: sub-minimum headroom rounds to 0', () => {
  // freeAmps = 25 - 22 + 0 = 3; give = 3 < 6 → 0
  const { allocations } = allocate(
    input({
      loadpoints: [lp({ id: 'a', mode: 'fast', currentA: 0, commandedA: 0 })],
      phaseCurrentsA: { i1: 22, i2: 0, i3: 0 },
    }),
  )
  expect(allocations.get('a')).toBe(0)
})

test('smart 6A floor: sub-minimum headroom rounds to 0', () => {
  // freeAmps = 25 - 22 + 0 = 3; share = 3 < 6 → 0
  const { allocations } = allocate(
    input({
      loadpoints: [lp({ id: 'a', mode: 'smart', currentA: 0, commandedA: 0 })],
      phaseCurrentsA: { i1: 22, i2: 0, i3: 0 },
    }),
  )
  expect(allocations.get('a')).toBe(0)
})

test('stale fallback: total commanded never exceeds mainBreakerA', () => {
  const lps = [
    lp({ id: 'a', mode: 'fast', currentA: 10, commandedA: 10 }),
    lp({ id: 'b', mode: 'smart', currentA: 10, commandedA: 10 }),
  ]
  const { allocations } = allocate(
    input({ loadpoints: lps, mainBreakerA: 16, phaseCurrentsA: null, meterStale: true }),
  )
  const total = (allocations.get('a') ?? 0) + (allocations.get('b') ?? 0)
  expect(total).toBeLessThanOrEqual(16)
})

test('stale fallback: fast loadpoint gets priority over smart', () => {
  // mainBreakerA=12 and safeStaticCurrentA=10 → only room for one at 10A
  const lps = [
    lp({ id: 'smart1', mode: 'smart', currentA: 0, commandedA: 0 }),
    lp({ id: 'fast1', mode: 'fast', currentA: 0, commandedA: 0 }),
  ]
  const { allocations } = allocate(
    input({
      loadpoints: lps,
      mainBreakerA: 12,
      phaseCurrentsA: null,
      meterStale: true,
      safeStaticCurrentA: 10,
    }),
  )
  expect(allocations.get('fast1')).toBe(10)
  // remaining = 12 - 10 = 2; 2 < 6 → 0
  expect(allocations.get('smart1')).toBe(0)
})

test('hysteresis: allocation within ±1A of commandedA stays unchanged', () => {
  // freeAmps = 20 - 21 + max(9,9) = 8; give = min(16,8) = 8; |8-9| = 1 ≤ 1 → stays at 9
  const { allocations } = allocate(
    input({
      loadpoints: [lp({ id: 'a', mode: 'fast', currentA: 9, commandedA: 9 })],
      mainBreakerA: 20,
      phaseCurrentsA: { i1: 21, i2: 0, i3: 0 },
    }),
  )
  expect(allocations.get('a')).toBe(9)
})

test('hysteresis breach: allocation outside ±1A moves to new value', () => {
  // freeAmps = 20 - 23 + max(9,9) = 6; give = min(16,6) = 6; |6-9| = 3 > 1 → moves to 6
  const { allocations } = allocate(
    input({
      loadpoints: [lp({ id: 'a', mode: 'fast', currentA: 9, commandedA: 9 })],
      mainBreakerA: 20,
      phaseCurrentsA: { i1: 23, i2: 0, i3: 0 },
    }),
  )
  expect(allocations.get('a')).toBe(6)
})

test('fast priority: fast gets headroom first, smart gets remainder', () => {
  // freeAmps = 25 - 13 + 0 = 12; fast gets min(12, 12) = 12; smart gets floor(0/1)=0 → sub-6A floor
  const lps = [
    lp({ id: 'smart1', mode: 'smart', currentA: 0, commandedA: 0 }),
    lp({ id: 'fast1', mode: 'fast', currentA: 0, commandedA: 0, maxCurrentA: 12 }),
  ]
  const { allocations } = allocate(
    input({
      loadpoints: lps,
      phaseCurrentsA: { i1: 13, i2: 0, i3: 0 },
    }),
  )
  expect(allocations.get('fast1')).toBe(12)
  expect(allocations.get('smart1')).toBe(0)
})
