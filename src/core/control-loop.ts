import type { ChargeMode, Config, LoadpointConfig } from './config.js'
import { shouldWrite } from './smart-charging/decide.js'

// The control loop drives every loadpoint on one slow, damped tick — independent of whether a
// balancer exists. Degradation is resolved upstream (the resolver ladders), so the only branch
// here is circuit topology: loadpoints sharing a balancer coordinate through it; a balancer-less
// loadpoint is its own circuit and takes the current resolver's budget directly.

export type Circuit =
  | { kind: 'balancer'; id: string; balancerName: string; loadpoints: LoadpointConfig[] }
  | { kind: 'bare'; id: string; loadpoint: LoadpointConfig }

/** Group configured loadpoints into circuits (one per balancer + one per balancer-less loadpoint). */
export function buildCircuits(config: Config): Circuit[] {
  const byBalancer = new Map<string, LoadpointConfig[]>()
  const circuits: Circuit[] = []
  for (const lp of config.loadpoints) {
    if (lp.balancer) {
      const arr = byBalancer.get(lp.balancer) ?? []
      arr.push(lp)
      byBalancer.set(lp.balancer, arr)
    } else {
      circuits.push({ kind: 'bare', id: `lp:${lp.name}`, loadpoint: lp })
    }
  }
  for (const [balancerName, loadpoints] of byBalancer) {
    circuits.push({ kind: 'balancer', id: `bal:${balancerName}`, balancerName, loadpoints })
  }
  return circuits
}

/** The circuit a given loadpoint belongs to (for an on-demand tick after a mode/target change). */
export function circuitForLoadpoint(circuits: Circuit[], loadpointName: string): Circuit | undefined {
  return circuits.find((c) =>
    c.kind === 'bare' ? c.loadpoint.name === loadpointName : c.loadpoints.some((l) => l.name === loadpointName),
  )
}

/**
 * Amps for a bare (no-balancer) loadpoint. `budgetA` is already clamped to [0, maxA] and floored
 * (<6 A ⇒ 0) by the current resolver, so the safety ceiling holds by construction — this only
 * gates on mode + the smart charge decision.
 */
export function bareCircuitAmps(
  mode: ChargeMode,
  shouldChargeNow: boolean | undefined,
  budgetA: number,
): number {
  if (mode === 'disabled') return 0
  if (mode === 'smart' && shouldChargeNow === false) return 0
  return budgetA
}

export interface LpDecision {
  loadpointName: string
  mode: ChargeMode
  /** From the planner for smart mode; undefined for fast/disabled (not gated on price). */
  shouldChargeNow?: boolean
  /** Resolved current budget, already clamped to maxA and floored (<6 ⇒ 0). */
  budgetA: number
  lastCommandedA?: number
}

export interface CircuitPlan {
  /** Target amps per loadpoint. */
  amps: Map<string, number>
  /** Subset that clears the deadband and should actually be written to the charger. */
  writes: Map<string, number>
}

/**
 * Pure decision core for one circuit tick. For a balancer circuit the coordinated per-loadpoint
 * allocation is passed in (from balancer.tick(), which owns multi-loadpoint splitting and is
 * covered by allocator.test.ts). For a bare circuit pass `null` and each loadpoint's amps come
 * from bareCircuitAmps. `writes` applies the deadband so a tiny delta doesn't chatter the charger.
 */
export function planCircuit(
  decisions: LpDecision[],
  balancerAllocations: Map<string, number> | null,
  deadbandA: number,
): CircuitPlan {
  const amps = new Map<string, number>()
  for (const d of decisions) {
    const a = balancerAllocations
      ? (balancerAllocations.get(d.loadpointName) ?? 0)
      : bareCircuitAmps(d.mode, d.shouldChargeNow, d.budgetA)
    amps.set(d.loadpointName, a)
  }
  const writes = new Map<string, number>()
  for (const d of decisions) {
    const a = amps.get(d.loadpointName) as number
    if (shouldWrite(a, d.lastCommandedA, deadbandA)) writes.set(d.loadpointName, a)
  }
  return { amps, writes }
}
