import { test, expect } from 'vitest'
import {
  buildCircuits,
  circuitForLoadpoint,
  bareCircuitAmps,
  circuitLiveMaxPhaseA,
  circuitOwnDrawA,
  planCircuit,
  shouldExpireFastToSmart,
  softStartLimit,
  type LpDecision,
} from './control-loop.js'
import type { Config, LoadpointConfig } from './config.js'
import type { MeterSnapshot } from '../sdk/meter-reader.js'
import type { ModuleHealth } from '../sdk/types.js'

const reader = (health: ModuleHealth, snap: MeterSnapshot | null) => ({
  health: () => health,
  latest: () => snap,
})
const snap = (i1: number, i2: number, i3: number): MeterSnapshot => ({
  i1A: i1,
  i2A: i2,
  i3A: i3,
  timestamp: new Date(0),
})

const lp = (name: string, balancer?: string): LoadpointConfig =>
  ({ name, charger: name, balancer, defaultMode: 'smart' }) as LoadpointConfig

test('circuitOwnDrawA sums max(currentA, commandedA) across the circuit (generalized credit-back)', () => {
  const states = new Map([
    ['a', { currentA: 6 }], // ramping — commanded higher than measured
    ['b', { currentA: 16 }], // steady
    ['c', { currentA: 0 }], // idle, never commanded
  ])
  const commanded = new Map([
    ['a', 16],
    ['b', 16],
  ])
  // a: max(6,16)=16; b: max(16,16)=16; c: max(0,0)=0 → 32. The ramping charger counts its commanded
  // 16 (not the measured 6), so the resolver's headroom isn't phantom-inflated mid-ramp.
  expect(circuitOwnDrawA([{ name: 'a' }, { name: 'b' }, { name: 'c' }], states, commanded)).toBe(32)
})

test('circuitLiveMaxPhaseA: a fresh named reader yields its max phase current (feeds the live rung)', () => {
  const readers = new Map([['house', reader('ok', snap(10, 8, 3))]])
  expect(circuitLiveMaxPhaseA('house', readers)).toBe(10)
})

test('circuitLiveMaxPhaseA: the staleness gate — degraded/unavailable/absent/frame-less → undefined', () => {
  // A degraded reader (past its staleAfterSec) must NOT feed the live rung — the resolver degrades.
  expect(
    circuitLiveMaxPhaseA('house', new Map([['house', reader('degraded', snap(10, 8, 3))]])),
  ).toBeUndefined()
  // Never-seen-a-frame reader.
  expect(
    circuitLiveMaxPhaseA('house', new Map([['house', reader('unavailable', null)]])),
  ).toBeUndefined()
  // Named reader that isn't registered.
  expect(
    circuitLiveMaxPhaseA('missing', new Map([['house', reader('ok', snap(10, 8, 3))]])),
  ).toBeUndefined()
  // Health says ok but no snapshot yet (defensive) — don't fabricate a 0-load reading.
  expect(circuitLiveMaxPhaseA('house', new Map([['house', reader('ok', null)]]))).toBeUndefined()
})

test('circuitLiveMaxPhaseA: unnamed selection — sole reader used; ambiguous (>1) degrades', () => {
  // No name + exactly one reader → the sole reader (single-meter install).
  expect(circuitLiveMaxPhaseA(undefined, new Map([['only', reader('ok', snap(5, 12, 7))]]))).toBe(
    12,
  )
  // No name + more than one reader → ambiguous → undefined (degrade, the safe choice).
  const two = new Map([
    ['a', reader('ok', snap(9, 9, 9))],
    ['b', reader('ok', snap(1, 1, 1))],
  ])
  expect(circuitLiveMaxPhaseA(undefined, two)).toBeUndefined()
})

test('buildCircuits: balancer loadpoints group into one circuit; the rest are bare', () => {
  const config = { loadpoints: [lp('a', 'house'), lp('b', 'house'), lp('c')] } as Config
  const circuits = buildCircuits(config)
  const bal = circuits.find((c) => c.kind === 'balancer')
  const bare = circuits.filter((c) => c.kind === 'bare')
  expect(bal?.kind === 'balancer' && bal.loadpoints.map((l) => l.name)).toEqual(['a', 'b'])
  expect(bare.map((c) => (c.kind === 'bare' ? c.loadpoint.name : ''))).toEqual(['c'])
})

test('circuitForLoadpoint resolves the owning circuit', () => {
  const circuits = buildCircuits({ loadpoints: [lp('a', 'house'), lp('c')] } as Config)
  expect(circuitForLoadpoint(circuits, 'a')?.id).toBe('bal:house')
  expect(circuitForLoadpoint(circuits, 'c')?.id).toBe('lp:c')
  expect(circuitForLoadpoint(circuits, 'nope')).toBeUndefined()
})

test('shouldExpireFastToSmart: Fast is a boost that reverts only after the car is unplugged past the grace', () => {
  const grace = 5 * 60_000
  const t0 = 1_000_000
  // Unplugged (Available) longer than the grace → revert fast → smart.
  expect(shouldExpireFastToSmart('fast', t0, t0 + grace + 1, grace)).toBe(true)
  // Unplugged only briefly (reposition / blip) → keep Fast.
  expect(shouldExpireFastToSmart('fast', t0, t0 + grace - 1, grace)).toBe(false)
  // Still plugged (or restart / WS blip → Unavailable, never sets the timer) → keep Fast.
  expect(shouldExpireFastToSmart('fast', undefined, t0 + 10 * grace, grace)).toBe(false)
  // Only Fast expires — smart/disabled are never auto-changed even if long "unplugged".
  expect(shouldExpireFastToSmart('smart', t0, t0 + 10 * grace, grace)).toBe(false)
  expect(shouldExpireFastToSmart('disabled', t0, t0 + 10 * grace, grace)).toBe(false)
})

test('softStartLimit: resume from ~0 commands half the target (≥6A); then full; no-op while drawing', () => {
  // Resuming (prev ~0): half the target, floored at the IEC 6 A minimum.
  expect(softStartLimit(14, 0)).toBe(7) // 14/2
  expect(softStartLimit(20, 0)).toBe(10)
  expect(softStartLimit(10, 0)).toBe(6) // 10/2=5 → floored to 6
  expect(softStartLimit(6, 0)).toBe(6) // target already at the minimum → no soft-start
  // Second tick: prev is now above the minimum → full target (the ramp completes).
  expect(softStartLimit(14, 7)).toBe(14)
  // Already drawing (prev ≥ min) → never soft-started.
  expect(softStartLimit(14, 13)).toBe(14)
  expect(softStartLimit(16, 16)).toBe(16)
})

test('bareCircuitAmps: disabled and smart-not-now → 0; smart-now/fast → the budget', () => {
  expect(bareCircuitAmps('disabled', undefined, 10)).toBe(0)
  expect(bareCircuitAmps('smart', false, 10)).toBe(0)
  expect(bareCircuitAmps('smart', true, 10)).toBe(10)
  expect(bareCircuitAmps('fast', undefined, 10)).toBe(10)
})

test('planCircuit (bare): amps from bareCircuitAmps; never exceeds the resolved budget', () => {
  const decisions: LpDecision[] = [
    { loadpointName: 'a', mode: 'smart', shouldChargeNow: true, budgetA: 8 },
    { loadpointName: 'b', mode: 'smart', shouldChargeNow: false, budgetA: 8, lastCommandedA: 0 },
    { loadpointName: 'c', mode: 'disabled', budgetA: 16, lastCommandedA: 10 },
  ]
  const { amps, writes } = planCircuit(decisions, null, 1)
  expect(amps.get('a')).toBe(8)
  expect(amps.get('b')).toBe(0)
  expect(amps.get('c')).toBe(0)
  for (const d of decisions) expect(amps.get(d.loadpointName)!).toBeLessThanOrEqual(d.budgetA) // safety
  expect(writes.has('a')).toBe(true) // first write (no lastCommanded)
  expect(writes.get('c')).toBe(0) // 10→0 is a real change
  expect(writes.has('b')).toBe(false) // 0→0 suppressed
})

test('planCircuit (balancer): uses coordinated allocations; deadband still applies', () => {
  const decisions: LpDecision[] = [
    { loadpointName: 'a', mode: 'smart', shouldChargeNow: true, budgetA: 0, lastCommandedA: 6 },
    { loadpointName: 'b', mode: 'fast', budgetA: 0, lastCommandedA: 10 },
  ]
  const alloc = new Map([
    ['a', 6],
    ['b', 12],
  ])
  const { amps, writes } = planCircuit(decisions, alloc, 1)
  expect(amps.get('a')).toBe(6)
  expect(amps.get('b')).toBe(12)
  expect(writes.has('a')).toBe(false) // 6→6 unchanged
  expect(writes.get('b')).toBe(12) // 10→12
})

test('planCircuit deadband suppresses a sub-1A change', () => {
  const decisions: LpDecision[] = [
    { loadpointName: 'a', mode: 'fast', budgetA: 10.4, lastCommandedA: 10 },
  ]
  expect(planCircuit(decisions, null, 1).writes.has('a')).toBe(false)
})
