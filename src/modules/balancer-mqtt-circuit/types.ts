export interface BalancerMqttCfg {
  name: string
  mainBreakerA: number
  phases: number
  meterTopicPrefix: string
  meterReader?: string
  safeStaticCurrentA: number
  meterStaleAfterSec: number
  intervalSec: number
}

export function parseConfig(raw: unknown): BalancerMqttCfg {
  // Defaults for phases/meterTopicPrefix/safeStaticCurrentA/meterStaleAfterSec/intervalSec
  // are applied upstream by the zod balancerConfigSchema (src/core/config.ts) — the single
  // source of truth. We trust those validated values here. The two guards below cover the
  // fields that have no schema default and keep the module usable in a standalone fork.
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string') throw new Error('balancer-mqtt-circuit: name is required')
  if (typeof r.mainBreakerA !== 'number')
    throw new Error('balancer-mqtt-circuit: mainBreakerA is required')
  return {
    name: r.name,
    mainBreakerA: r.mainBreakerA,
    phases: r.phases as number,
    meterTopicPrefix: r.meterTopicPrefix as string,
    meterReader: typeof r.meterReader === 'string' ? r.meterReader : undefined,
    safeStaticCurrentA: r.safeStaticCurrentA as number,
    meterStaleAfterSec: r.meterStaleAfterSec as number,
    intervalSec: r.intervalSec as number,
  }
}
