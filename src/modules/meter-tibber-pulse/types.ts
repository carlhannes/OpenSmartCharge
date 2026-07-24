import { parseBroker, type Broker } from '../../sdk/broker.js'

export interface PulseConfig {
  name: string
  type: string
  subTopic: string
  ctrlTopics: string[]
  disablePayload: string
  disableIntervalSec: number
  staleAfterSec: number
  republishPrefix?: string
  /** This reader's own broker to LISTEN on — self-contained, independent of OSC's outbound bridge. */
  broker: Broker
}

export function parseConfig(cfg: unknown): PulseConfig {
  const c = cfg as Record<string, unknown>
  if (typeof c.name !== 'string') throw new Error('meterReader config missing name')
  return {
    name: c.name,
    type: typeof c.type === 'string' ? c.type : 'tibber-pulse',
    broker: parseBroker(c.broker, `meter-tibber-pulse '${String(c.name)}'`),
    subTopic: typeof c.subTopic === 'string' ? c.subTopic : 'pulse',
    ctrlTopics: Array.isArray(c.ctrlTopics)
      ? (c.ctrlTopics as string[])
      : ['pctrl', 'pulse/subscribe'],
    disablePayload:
      typeof c.disablePayload === 'string' ? c.disablePayload : 'batching_disable true',
    disableIntervalSec: typeof c.disableIntervalSec === 'number' ? c.disableIntervalSec : 300,
    staleAfterSec: typeof c.staleAfterSec === 'number' ? c.staleAfterSec : 60,
    republishPrefix: typeof c.republishPrefix === 'string' ? c.republishPrefix : undefined,
  }
}
