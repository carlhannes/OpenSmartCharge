import type { LoadpointSnapshot } from '../../sdk/balancer.js'

const OCPP_MIN_A = 6 // per-loadpoint minimum below which we round to 0

export function allocate(input: {
  loadpoints: LoadpointSnapshot[]
  mainBreakerA: number
  phaseCurrentsA: { i1: number; i2: number; i3: number } | null
  meterStale: boolean
  safeStaticCurrentA: number
}): Map<string, number> {
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

  if (wanting.length === 0) return result

  // Meter stale path: fixed safe current per wanting loadpoint
  if (meterStale || phaseCurrentsA === null) {
    for (const lp of wanting) {
      result.set(lp.id, Math.min(safeStaticCurrentA, lp.maxCurrentA))
    }
    return result
  }

  // Compute headroom: add back what chargers are currently drawing before re-distributing
  const maxPhase = Math.max(phaseCurrentsA.i1, phaseCurrentsA.i2, phaseCurrentsA.i3)
  const chargerCreditBack = loadpoints.reduce((s, lp) => s + lp.currentA, 0)
  const freeAmps = Math.max(0, mainBreakerA - maxPhase + chargerCreditBack)

  // fast loadpoints get priority (served in declaration order)
  const fast = wanting.filter((lp) => lp.mode === 'fast')
  const smart = wanting.filter((lp) => lp.mode !== 'fast')

  let remaining = freeAmps

  for (const lp of fast) {
    const give = Math.min(lp.maxCurrentA, remaining)
    result.set(lp.id, give)
    remaining -= give
  }

  // smart loadpoints: equal split of remaining headroom
  if (smart.length > 0) {
    const share = Math.floor(remaining / smart.length)
    for (const lp of smart) {
      const give = Math.min(share, lp.maxCurrentA)
      result.set(lp.id, give < OCPP_MIN_A ? 0 : give)
    }
  }

  return result
}
