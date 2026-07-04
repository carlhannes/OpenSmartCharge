import { test, expect } from 'vitest'
import {
  buildCircuits,
  circuitForLoadpoint,
  bareCircuitAmps,
  planCircuit,
  type LpDecision,
} from './control-loop.js'
import type { Config, LoadpointConfig } from './config.js'

const lp = (name: string, balancer?: string): LoadpointConfig =>
  ({ name, charger: name, balancer, defaultMode: 'smart', autoStart: true }) as LoadpointConfig

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
