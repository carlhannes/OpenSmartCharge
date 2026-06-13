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
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string') throw new Error('balancer-mqtt-circuit: name is required')
  if (typeof r.mainBreakerA !== 'number')
    throw new Error('balancer-mqtt-circuit: mainBreakerA is required')
  return {
    name: r.name,
    mainBreakerA: r.mainBreakerA,
    phases: typeof r.phases === 'number' ? r.phases : 3,
    meterTopicPrefix: typeof r.meterTopicPrefix === 'string' ? r.meterTopicPrefix : 'house',
    meterReader: typeof r.meterReader === 'string' ? r.meterReader : undefined,
    safeStaticCurrentA: typeof r.safeStaticCurrentA === 'number' ? r.safeStaticCurrentA : 10,
    meterStaleAfterSec: typeof r.meterStaleAfterSec === 'number' ? r.meterStaleAfterSec : 60,
    intervalSec: typeof r.intervalSec === 'number' ? r.intervalSec : 15,
  }
}
