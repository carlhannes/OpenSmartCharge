import type { LoadpointSnapshot } from '../../sdk/balancer.js'
import { IEC_MIN_CURRENT_A } from '../../sdk/electrical.js'

const HYSTERESIS_A = 1 // dead-band: ignore a rise of ≤ 1 A over the last commanded value

// Hysteresis only ever HOLDS a lower value: a small budget rise keeps the previous command (no
// micro-oscillation), but a drop always follows the budget — holding the old, higher value would
// allocate more than the circuit has (and the lifecycle's deadband would then keep it there).
const settle = (give: number, prev: number | undefined): number =>
  prev !== undefined && prev <= give && give - prev <= HYSTERESIS_A ? prev : give

/**
 * Split a circuit's already-resolved current budget across its loadpoints. `circuitBudgetA` comes
 * from the lifecycle's current-resolver ladder (live-meter headroom → historical worst-case → static
 * time-of-day), so this is PURE allocation — it does NOT read the meter, compute headroom, or decide
 * staleness (that's the meter reader's + resolver's job). Fast loadpoints are served first
 * (declaration order); smart loadpoints share the remainder equally. Hysteresis avoids
 * micro-oscillation; the IEC 61851 §A.4.1.1 6 A minimum floors a sub-minimum share to 0.
 */
export function allocate(input: { loadpoints: LoadpointSnapshot[]; circuitBudgetA: number }): {
  allocations: Map<string, number>
} {
  const { loadpoints, circuitBudgetA } = input
  const result = new Map<string, number>()

  // Who wants current this tick?
  const wanting = loadpoints.filter((lp) => {
    if (lp.mode === 'disabled') return false
    if (lp.mode === 'smart') return lp.shouldChargeNow !== false // smart folds target/minSoc/climate/price
    // fast: wants budget unless its plan's target is reached and pause-on-target is set (→ Ready)
    return !(lp.targetReached && lp.pauseOnTarget)
  })

  // Zero out non-wanting loadpoints first.
  for (const lp of loadpoints) {
    if (!wanting.includes(lp)) result.set(lp.id, 0)
  }
  if (wanting.length === 0) return { allocations: result }

  const fast = wanting.filter((lp) => lp.mode === 'fast')
  const smart = wanting.filter((lp) => lp.mode !== 'fast')

  let remaining = circuitBudgetA

  // fast loadpoints get priority (served in declaration order)
  for (const lp of fast) {
    const give = Math.min(lp.maxCurrentA, remaining)
    // Hysteresis before the floor, so a held value is still subject to the IEC minimum.
    const stable = settle(give, lp.commandedA)
    const final = stable < IEC_MIN_CURRENT_A ? 0 : stable
    result.set(lp.id, final)
    remaining -= final
  }

  // smart loadpoints: equal split of the remaining budget
  if (smart.length > 0) {
    const share = Math.floor(remaining / smart.length)
    for (const lp of smart) {
      const give = Math.min(share, lp.maxCurrentA)
      const stable = settle(give, lp.commandedA)
      result.set(lp.id, stable < IEC_MIN_CURRENT_A ? 0 : stable)
    }
  }

  return { allocations: result }
}
