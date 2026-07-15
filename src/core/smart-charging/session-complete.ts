import type { EnergyRung } from './types.js'

// Pure decision: has the current plug-in session COMPLETED? A session is "done" when the car has
// stopped taking charge for a real reason — a genuine target was reached, or the car itself refuses
// more current after we've delivered something — as opposed to a transient pause (cheap-window wait,
// initial ramp, thermal blip). The lifecycle recomputes this each control tick and uses it to (a)
// silence the SessionReconciler (its episode-reset guard) and (b) surface a "Ready" state to the UI,
// so a full car no longer churns empty transactions. Guest-capable: never depends on car telemetry.
//
// Passive by design: "complete" only stops OSC from RE-INITIATING — it never sends a stop. So a false
// positive during a pause self-heals (the open transaction resumes → the car draws → complete clears).
// This generalizes the reconciler's bound-car-only `carAtTarget` guard into a guest-capable signal.

export interface SessionCompleteInput {
  /** A car is present (OCPP status not Available/Unavailable/Faulted). */
  connected: boolean
  /** The car is preconditioning while plugged — an intentional grid load, never "done". */
  climateActive: boolean
  /** kWh delivered this plug-in (peak-hold across the transaction churn). The "we charged something"
   *  gate — 0 during the initial ramp, so a car that never started isn't called complete. */
  deliveredKWh: number
  /** Amps OSC is offering this tick (commanded > 0 = we WANT it to charge). */
  commandedA: number
  /** Live draw (A). At/above `drawA` the car is actively charging → never complete. */
  drawingA: number
  /** kWh still needed for the resolved target (0 = target met). */
  requiredKWh: number
  /** Which rung the energy target resolved on. Only a REAL SoC target ('soc-capacity') completes on
   *  `requiredKWh<=0`; a 'target-kwh' figure (especially a guest's) is a planning estimate, never a
   *  stop — the guest session completes only when the car itself refuses charge. */
  energySource: EnergyRung
  /** ms epoch when the car first went ~0 A while we were offering current, threaded across ticks;
   *  undefined resets the settle timer. */
  zeroDrawSinceMs?: number
  /** ms epoch. */
  now: number
}

export interface SessionCompleteCfg {
  /** Must have delivered at least this much to count as a session (guards the initial ramp). */
  minKWh: number
  /** At/above this draw the car is charging (mirrors the UI's 0.5 A "drawing" threshold). */
  drawA: number
  /** How long the car must sit ~0 A while we offer current before we call it done. Kept BELOW the
   *  reconciler's graceMs so completion pre-empts its `resume` (which would end the transaction). */
  settleMs: number
}

/** Defaults. `settleMs` (60 s) is deliberately below SESSION_RECONCILE.graceMs (90 s). */
export const SESSION_COMPLETE: SessionCompleteCfg = {
  minKWh: 0.1,
  drawA: 0.5,
  settleMs: 60_000,
}

export interface SessionCompleteResult {
  complete: boolean
  /** The (possibly updated) settle-timer anchor to store for the next tick. */
  zeroDrawSinceMs?: number
}

/**
 * Has this plug-in session completed? Two ways, both requiring we've delivered energy and the car
 * isn't drawing now:
 *  - socTargetReached: a real SoC/%/km target is met (`requiredKWh<=0` on the 'soc-capacity' rung).
 *  - carStoppedItself: we're offering current but the car has refused it for `settleMs` (full / done).
 * Never on a guest kWh estimate; never while climatising, ramping, or actively drawing.
 */
export function resolveSessionComplete(
  i: SessionCompleteInput,
  cfg: SessionCompleteCfg,
): SessionCompleteResult {
  // No session, preconditioning, nothing delivered yet, or actively drawing → not complete; drop the
  // settle timer so a later ~0 A spell starts its window fresh.
  if (!i.connected || i.climateActive || i.deliveredKWh <= cfg.minKWh || i.drawingA >= cfg.drawA) {
    return { complete: false, zeroDrawSinceMs: undefined }
  }

  // A real SoC target met (NOT a kWh estimate) → done immediately, whatever we're commanding.
  const socTargetReached = i.requiredKWh <= 0 && i.energySource === 'soc-capacity'

  // Sustained refusal: we're offering current but the car draws ~0. Anchor the window on the first
  // such tick (drawing is already excluded above); clear it when we stop offering.
  const zeroDrawSinceMs = i.commandedA > 0 ? (i.zeroDrawSinceMs ?? i.now) : undefined
  const carStoppedItself = zeroDrawSinceMs !== undefined && i.now - zeroDrawSinceMs >= cfg.settleMs

  return { complete: socTargetReached || carStoppedItself, zeroDrawSinceMs }
}
