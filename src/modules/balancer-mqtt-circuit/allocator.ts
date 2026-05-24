import type { LoadpointSnapshot } from '../../sdk/balancer.js'

const OCPP_MIN_A = 6 // per-loadpoint minimum below which we round to 0

export function allocate(input: {
  loadpoints: LoadpointSnapshot[]
  mainBreakerA: number
  phaseCurrentsA: { i1: number; i2: number; i3: number } | null
  meterStale: boolean
  safeStaticCurrentA: number
}): { allocations: Map<string, number>; freeAmps: number } {
  const { loadpoints, mainBreakerA, phaseCurrentsA, meterStale, safeStaticCurrentA } = input
  const result = new Map<string, number>()

  // Classify: who wants current this tick?
  const wanting = loadpoints.filter((lp) => {
    if (lp.mode === 'disabled') return false
    if (lp.mode === 'smart' && lp.shouldChargeNow === false) return false
    return true
  })

  // Always zero out non-wanting loadpoints first
  for (const lp of loadpoints) {
    if (!wanting.includes(lp)) result.set(lp.id, 0)
  }

  if (wanting.length === 0) return { allocations: result, freeAmps: 0 }

  // Meter stale path: fixed safe current per wanting loadpoint, capped at the main breaker.
  // Fast loadpoints served first so at least one charger keeps going if headroom is tight.
  if (meterStale || phaseCurrentsA === null) {
    let remaining = mainBreakerA
    const stalePriority = [
      ...wanting.filter((lp) => lp.mode === 'fast'),
      ...wanting.filter((lp) => lp.mode !== 'fast'),
    ]
    for (const lp of stalePriority) {
      const give = Math.min(safeStaticCurrentA, lp.maxCurrentA, remaining)
      result.set(lp.id, give < OCPP_MIN_A ? 0 : give)
      remaining -= give
    }
    return { allocations: result, freeAmps: 0 }
  }

  // Compute headroom: add back what chargers are currently drawing (or commanded — whichever is
  // higher) before re-distributing. Using max(currentA, commandedA) prevents phantom headroom
  // during the 5–30 s a car ramps up to a newly commanded level, which would otherwise cause
  // the allocator to over-assign on the next tick and then yank current back when the car arrives.
  const maxPhase = Math.max(phaseCurrentsA.i1, phaseCurrentsA.i2, phaseCurrentsA.i3)
  const chargerCreditBack = loadpoints.reduce(
    (s, lp) => s + Math.max(lp.currentA, lp.commandedA ?? 0),
    0,
  )
  const freeAmps = Math.max(0, mainBreakerA - maxPhase + chargerCreditBack)

  // fast loadpoints get priority (served in declaration order)
  const fast = wanting.filter((lp) => lp.mode === 'fast')
  const smart = wanting.filter((lp) => lp.mode !== 'fast')

  let remaining = freeAmps

  for (const lp of fast) {
    const give = Math.min(lp.maxCurrentA, remaining)
    // IEC 61851 §A.4.1.1: minimum pilot signal current is 6 A; round sub-minimum to 0.
    const final = give < OCPP_MIN_A ? 0 : give
    result.set(lp.id, final)
    remaining -= final
  }

  // smart loadpoints: equal split of remaining headroom
  if (smart.length > 0) {
    const share = Math.floor(remaining / smart.length)
    for (const lp of smart) {
      const give = Math.min(share, lp.maxCurrentA)
      result.set(lp.id, give < OCPP_MIN_A ? 0 : give)
    }
  }

  return { allocations: result, freeAmps }
}
