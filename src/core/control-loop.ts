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
): number {
  if (mode === 'disabled') return 0
  if (mode === 'smart' && shouldChargeNow === false) return 0
  return budgetA
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

export interface ResumeNudgeState {
  /** When the current "wants to charge but not drawing" episode began (ms epoch), or undefined. */
  stalledSinceMs?: number
  /** Last nudge time (ms epoch), or undefined. */
  lastNudgeMs?: number
  /** Nudges issued this episode — reset once the car draws again or stops wanting charge. */
  nudges: number
}

export interface ResumeNudgeCfg {
  /** Below this many amps the car counts as "not drawing". */
  minDrawA: number
  /** Absorb the normal ramp (SuspendedEVSE→Charging takes seconds) before nudging. */
  graceMs: number
  /** Wait this long after a nudge before trying again (lets a fresh transaction ramp). */
  cooldownMs: number
  /** Give up after this many nudges in one episode (never stop/start a stuck car forever). */
  maxNudges: number
}

/**
 * Decide whether to "nudge" a stuck car back into charging. Some cars (VW group — the Enyaq) latch
 * `SuspendedEV` after the EVSE offers 0 A (an OSC target/price pause) and will NOT resume when the
 * limit is raised again — only a fresh transaction (RemoteStop+RemoteStart) restarts them. So when
 * OSC wants current (`wantsCharge`), the car is plugged (`connected`) with an ACTIVE session
 * (`sessionActive` — a transaction is open: status Charging/SuspendedEV/SuspendedEVSE) yet is drawing
 * ~0 A, we resume it.
 *
 * Requiring an active session is deliberate: it means we only ever RESUME an open transaction, never
 * START one — so `autoStart: false` is respected (only connect-time autostart or a manual start opens
 * a session). Guards: `graceMs` absorbs the normal ramp, `cooldownMs` spaces retries so a fresh
 * transaction can ramp, and `maxNudges` stops us stop/starting a genuinely-stuck car forever.
 *
 * Pure: returns the decision + the next state (no mutation).
 */
export function resumeNudgeDecision(
  state: ResumeNudgeState,
  input: {
    wantsCharge: boolean
    connected: boolean
    sessionActive: boolean
    drawingA: number
    now: number
  },
  cfg: ResumeNudgeCfg,
): { nudge: boolean; next: ResumeNudgeState } {
  const stalling =
    input.wantsCharge && input.connected && input.sessionActive && input.drawingA < cfg.minDrawA
  if (!stalling) return { nudge: false, next: { nudges: 0 } } // drawing or not-wanting → reset episode
  const stalledSinceMs = state.stalledSinceMs ?? input.now
  const base: ResumeNudgeState = { ...state, stalledSinceMs }
  if (input.now - stalledSinceMs < cfg.graceMs) return { nudge: false, next: base } // ramp grace
  if (state.nudges >= cfg.maxNudges) return { nudge: false, next: base } // gave up this episode
  if (state.lastNudgeMs !== undefined && input.now - state.lastNudgeMs < cfg.cooldownMs)
    return { nudge: false, next: base } // still cooling down since the last nudge
  return { nudge: true, next: { stalledSinceMs, lastNudgeMs: input.now, nudges: state.nudges + 1 } }
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
