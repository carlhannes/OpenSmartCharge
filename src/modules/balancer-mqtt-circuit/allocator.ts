import type { LoadpointSnapshot } from '../../sdk/balancer.js'

const OCPP_MIN_A = 6 // per-loadpoint minimum below which we round to 0
const HYSTERESIS_A = 1 // dead-band: ignore allocation changes within ±1A of last commanded value

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
    if (lp.mode === 'smart' && lp.shouldChargeNow === false) return false
    return true
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
    // Apply hysteresis before the floor: if the candidate is within ±HYSTERESIS_A of the last
    // commanded value, keep the existing value to avoid micro-oscillation on small load wobble.
    const prev = lp.commandedA
    const stable = prev !== undefined && Math.abs(give - prev) <= HYSTERESIS_A ? prev : give
    const final = stable < OCPP_MIN_A ? 0 : stable
    result.set(lp.id, final)
    remaining -= final
  }

  // smart loadpoints: equal split of the remaining budget
  if (smart.length > 0) {
    const share = Math.floor(remaining / smart.length)
    for (const lp of smart) {
      const give = Math.min(share, lp.maxCurrentA)
      const prev = lp.commandedA
      const stable = prev !== undefined && Math.abs(give - prev) <= HYSTERESIS_A ? prev : give
      result.set(lp.id, stable < OCPP_MIN_A ? 0 : stable)
    }
  }

  return { allocations: result }
}
