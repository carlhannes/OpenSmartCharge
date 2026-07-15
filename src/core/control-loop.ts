import type { ChargeMode, Config, LoadpointConfig } from './config.js'
import type { ModuleHealth } from '../sdk/types.js'
import type { MeterSnapshot } from '../sdk/meter-reader.js'
import { shouldWrite } from './smart-charging/decide.js'

/** The slice of a MeterReader the current-budget resolver needs: its freshness + last frame. */
type MeterReaderLike = { health(): ModuleHealth; latest(): MeterSnapshot | null }

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
export function circuitForLoadpoint(
  circuits: Circuit[],
  loadpointName: string,
): Circuit | undefined {
  return circuits.find((c) =>
    c.kind === 'bare'
      ? c.loadpoint.name === loadpointName
      : c.loadpoints.some((l) => l.name === loadpointName),
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
  targetReached: boolean,
  pauseOnTarget: boolean,
): number {
  if (mode === 'disabled') return 0
  // Smart already folds target/minSoc/climate/price into shouldChargeNow (minSoc/climate override the
  // target-stop there), so honour it directly.
  if (mode === 'smart') return shouldChargeNow === false ? 0 : budgetA
  // Fast charges unconditionally EXCEPT when the active plan's target is reached and pause-on-target is
  // set — then it pauses too (→ "Ready"). pause-on-target OFF (e.g. the Guest default) keeps charging.
  return targetReached && pauseOnTarget ? 0 : budgetA
}

/** Default grace before a `fast` boost expires back to `smart` once the car is unplugged. */
export const FAST_BOOST_UNPLUG_GRACE_MS = 5 * 60_000

/**
 * Soft-start on resume: the FIRST command after a pause (previous commanded ~0) is capped to half
 * the target — floored at the IEC minimum so it stays a valid charge current — so the car ramps up
 * gently instead of jumping straight to a high limit and briefly overshooting the fuse (the car
 * pulls its prior rate for an instant on resume). One tick later the full target applies. A no-op
 * when already drawing (prev ≥ minA) or the target is already ≤ minA. This shrinks overshoot
 * MAGNITUDE without adding steering FREQUENCY (same 30 s cadence). Pure.
 */
export function softStartLimit(targetA: number, prevCommandedA: number, minA = 6): number {
  if (prevCommandedA >= minA || targetA <= minA) return targetA
  return Math.max(minA, Math.floor(targetA / 2))
}

/**
 * Whether a `fast` "boost" should revert to `smart`. Fast is a deliberate one-shot override ("charge
 * flat-out now"), like a boost button — it should last until the car is genuinely UNPLUGGED, not be
 * cancelled by transients. `availableUnpluggedSinceMs` is when the OCPP connector first went
 * `Available` (a real unplug), or undefined when the car is plugged. Fast reverts only after that
 * exceeds `graceMs`, so a brief reposition-unplug, a wifi/WS blip (which reports `Unavailable`, not
 * `Available`, so never sets this), and an OSC restart (no Available observed) all KEEP Fast — only a
 * true end-of-session reverts it. `smart`/`disabled` are unaffected. Pure.
 */
export function shouldExpireFastToSmart(
  mode: ChargeMode,
  availableUnpluggedSinceMs: number | undefined,
  now: number,
  graceMs: number,
): boolean {
  return (
    mode === 'fast' &&
    availableUnpluggedSinceMs !== undefined &&
    now - availableUnpluggedSinceMs > graceMs
  )
}

/**
 * Total current the chargers on a circuit draw (or were commanded — whichever is higher), summed
 * across the circuit. Credited back into the live-meter headroom rung so a car ramping up to a
 * freshly-commanded level isn't under-counted (which would make the resolver yank current back on
 * the next tick). Generalizes the single-charger credit-back to N chargers on a shared circuit.
 */
export function circuitOwnDrawA(
  loadpoints: { name: string }[],
  states: Map<string, { currentA: number }>,
  lastCommandedA: Map<string, number>,
): number {
  return loadpoints.reduce((sum, lp) => {
    const cur = states.get(lp.name)?.currentA ?? 0
    const cmd = lastCommandedA.get(lp.name) ?? 0
    return sum + Math.max(cur, cmd)
  }, 0)
}

/**
 * Live household load (max phase current) for a circuit's meter — the meter-SSoT selection plus the
 * one staleness gate. Feeds the live-meter rung of resolveCurrentBudget ONLY when the chosen reader
 * is fresh (its own health() === 'ok'); a degraded/absent/ambiguous reader returns undefined, so the
 * resolver degrades to the historical/static rungs. Reader selection:
 *  - a named reader (balancers[].meterReader) → that reader;
 *  - no name + exactly one reader → the sole reader (single-meter installs);
 *  - no name + more than one reader → undefined (ambiguous — degrade, the safe choice).
 */
export function circuitLiveMaxPhaseA(
  meterReaderName: string | undefined,
  readers: Map<string, MeterReaderLike>,
): number | undefined {
  let reader: MeterReaderLike | undefined
  if (meterReaderName) reader = readers.get(meterReaderName)
  else if (readers.size === 1) reader = [...readers.values()][0]
  if (!reader || reader.health() !== 'ok') return undefined
  const s = reader.latest()
  return s ? Math.max(s.i1A ?? 0, s.i2A ?? 0, s.i3A ?? 0) : undefined
}

export interface LpDecision {
  loadpointName: string
  mode: ChargeMode
  /** From the planner for smart mode; undefined for fast/disabled (not gated on price). */
  shouldChargeNow?: boolean
  /** Resolved current budget, already clamped to maxA and floored (<6 ⇒ 0). */
  budgetA: number
  lastCommandedA?: number
  /** The active plan's target is reached (requiredKWh <= 0). */
  targetReached: boolean
  /** The active plan's pause-on-target toggle — stops charging at target in ALL modes when true. */
  pauseOnTarget: boolean
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
      : bareCircuitAmps(d.mode, d.shouldChargeNow, d.budgetA, d.targetReached, d.pauseOnTarget)
    amps.set(d.loadpointName, a)
  }
  const writes = new Map<string, number>()
  for (const d of decisions) {
    const a = amps.get(d.loadpointName) as number
    if (shouldWrite(a, d.lastCommandedA, deadbandA)) writes.set(d.loadpointName, a)
  }
  return { amps, writes }
}
