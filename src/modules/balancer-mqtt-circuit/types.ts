export interface BalancerMqttCfg {
  name: string
}

// The pure splitter only needs its own name (for the module id). Everything else — mainBreakerA,
// the per-breaker margins, the meterReader link — is read by the LIFECYCLE from the zod-validated
// balancer config, not here. Deprecated meter fields (meterTopicPrefix / safeStaticCurrentA /
// meterStaleAfterSec) are ignored.
export function parseConfig(raw: unknown): BalancerMqttCfg {
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string') throw new Error('balancer-mqtt-circuit: name is required')
  return { name: r.name }
}
