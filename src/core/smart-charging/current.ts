import { isNight } from '../../sdk/local-time.js'
import type { Resolved, CurrentRung, NightWindow } from './types.js'

const IEC_MIN_A = 6

export interface CurrentInputs {
  now: Date
  /** Charger hardware ceiling — the hard cap on the result. */
  maxCurrentA: number
  /** Circuit main fuse (from a balancer, or site.mainBreakerA for a bare loadpoint). */
  mainBreakerA?: number
  /** max(i1,i2,i3) from a FRESH meter snapshot; undefined → skip the live rung. */
  liveMaxPhaseA?: number
  /** This charger's own draw max(currentA, commandedA) — credited back to avoid ramp oscillation. */
  ownDrawA?: number
  /** Worst-case household load for this hour over the last N days; undefined → skip historical. */
  worstCaseLoadA?: number
  nightWindow: NightWindow
  nightMarginA?: number
  daytimeFraction?: number
  /** IEC minimum charge current; a budget below this resolves to 0 (never rounded up). */
  minCurrentA?: number
  /** Site timezone for the night-window check. */
  tz: string
}

/**
 * Resolve the amps a CIRCUIT may draw (bare = its one loadpoint; balancer = the shared circuit the
 * balancer then splits), degrading:
 *  1. live-meter           — mainBreakerA − liveMaxPhaseA + circuit ownDraw (credit-back)
 *  2. historical-worstcase — mainBreakerA − worst-load-this-hour − 1 A safety
 *  3. static-tod           — night: mainBreakerA − nightMarginA, day: mainBreakerA × daytimeFraction
 *
 * With no mainBreakerA (a single dedicated circuit, no house meter) the charger ceiling IS the
 * circuit limit — the correct answer for that topology, not a degradation.
 *
 * Every result is clamped to [0, maxCurrentA] then floored: a budget below the IEC 6 A minimum
 * becomes 0 (charging at 6 A when only 5 A is safe would exceed the budget and risk the breaker).
 */
export function resolveCurrentBudget(i: CurrentInputs): Resolved<number, CurrentRung> {
  const minA = i.minCurrentA ?? IEC_MIN_A
  const settle = (amps: number): number => {
    const capped = Math.max(0, Math.min(amps, i.maxCurrentA))
    return capped < minA ? 0 : capped
  }

  if (i.mainBreakerA != null && i.liveMaxPhaseA != null) {
    const free = i.mainBreakerA - i.liveMaxPhaseA + (i.ownDrawA ?? 0)
    return { value: settle(free), source: 'live-meter', degraded: false }
  }

  if (i.mainBreakerA != null && i.worstCaseLoadA != null) {
    return {
      value: settle(i.mainBreakerA - i.worstCaseLoadA - 1),
      source: 'historical-worstcase',
      degraded: true,
    }
  }

  if (i.mainBreakerA != null) {
    const night = isNight(i.now, i.nightWindow.startHour, i.nightWindow.endHour, i.tz)
    const budget = night
      ? i.mainBreakerA - (i.nightMarginA ?? 3)
      : i.mainBreakerA * (i.daytimeFraction ?? 0.5)
    return { value: settle(budget), source: 'static-tod', degraded: true }
  }

  // No circuit fuse known: the charger's own ceiling is the limit. Not degraded — it's the
  // expected steady state for a dedicated single-charger circuit with no house meter.
  return { value: settle(i.maxCurrentA), source: 'static-tod', degraded: false }
}
