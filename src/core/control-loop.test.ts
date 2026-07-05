import { test, expect } from 'vitest'
import {
  buildCircuits,
  circuitForLoadpoint,
  bareCircuitAmps,
  circuitLiveMaxPhaseA,
  circuitOwnDrawA,
  resumeNudgeDecision,
  planCircuit,
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
  ({ name, charger: name, balancer, defaultMode: 'smart', autoStart: true }) as LoadpointConfig

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

test('resumeNudgeDecision: nudges a stuck active session after grace, then respects cooldown + cap', () => {
  const cfg = { minDrawA: 1, graceMs: 90_000, cooldownMs: 180_000, maxNudges: 3 }
  const stuck = { wantsCharge: true, connected: true, sessionActive: true, drawingA: 0 }

  // first tick of the stall → record stalledSince, no nudge yet (ramp grace)
  let r = resumeNudgeDecision({ nudges: 0 }, { ...stuck, now: 0 }, cfg)
  expect(r.nudge).toBe(false)
  expect(r.next.stalledSinceMs).toBe(0)
  // still within grace → no nudge
  r = resumeNudgeDecision(r.next, { ...stuck, now: 60_000 }, cfg)
  expect(r.nudge).toBe(false)
  // past grace → nudge #1
  r = resumeNudgeDecision(r.next, { ...stuck, now: 100_000 }, cfg)
  expect(r.nudge).toBe(true)
  expect(r.next.nudges).toBe(1)
  // within cooldown → no re-nudge
  expect(resumeNudgeDecision(r.next, { ...stuck, now: 150_000 }, cfg).nudge).toBe(false)
  // past cooldown → nudge #2, then #3
  r = resumeNudgeDecision(r.next, { ...stuck, now: 300_000 }, cfg)
  expect(r.nudge).toBe(true)
  r = resumeNudgeDecision(r.next, { ...stuck, now: 500_000 }, cfg)
  expect(r.nudge).toBe(true)
  expect(r.next.nudges).toBe(3)
  // cap reached → give up
  expect(resumeNudgeDecision(r.next, { ...stuck, now: 700_000 }, cfg).nudge).toBe(false)
})

test('resumeNudgeDecision: no nudge without an active session (respects autoStart), when drawing, paused, or unplugged', () => {
  const cfg = { minDrawA: 1, graceMs: 90_000, cooldownMs: 180_000, maxNudges: 3 }
  const base = {
    wantsCharge: true,
    connected: true,
    sessionActive: true,
    drawingA: 0,
    now: 200_000,
  }
  // Preparing (no open transaction) → must NOT start one here — that's autoStart's job
  expect(resumeNudgeDecision({ nudges: 0 }, { ...base, sessionActive: false }, cfg).nudge).toBe(
    false,
  )
  // already drawing → no nudge, and the episode resets
  const drawing = resumeNudgeDecision(
    { stalledSinceMs: 0, lastNudgeMs: 100_000, nudges: 2 },
    { ...base, drawingA: 7.5 },
    cfg,
  )
  expect(drawing.nudge).toBe(false)
  expect(drawing.next).toEqual({ nudges: 0 })
  // intentionally paused (OSC commands 0 A) → no nudge
  expect(resumeNudgeDecision({ nudges: 0 }, { ...base, wantsCharge: false }, cfg).nudge).toBe(false)
  // unplugged → no nudge
  expect(resumeNudgeDecision({ nudges: 0 }, { ...base, connected: false }, cfg).nudge).toBe(false)
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
