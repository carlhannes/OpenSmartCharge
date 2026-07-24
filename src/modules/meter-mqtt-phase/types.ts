import { parseBroker, type Broker } from '../../sdk/broker.js'

export interface MqttPhaseConfig {
  name: string
  type: string
  /** Topic prefix for the raw per-phase current feed: subscribes to `{prefix}/i{1,2,3}_a`. */
  topicPrefix: string
  /** A snapshot older than this is reported `degraded` by health() — the ONE staleness authority. */
  staleAfterSec: number
  /** This reader's own broker to LISTEN on — self-contained, independent of OSC's outbound bridge. */
  broker: Broker
}

export function parseConfig(cfg: unknown): MqttPhaseConfig {
  const c = cfg as Record<string, unknown>
  if (typeof c.name !== 'string') throw new Error('meterReader config missing name')
  return {
    name: c.name,
    type: typeof c.type === 'string' ? c.type : 'mqtt-phase',
    // Default matches the legacy balancer's `meterTopicPrefix: house` for drop-in migration.
    topicPrefix: typeof c.topicPrefix === 'string' ? c.topicPrefix : 'house',
    staleAfterSec: typeof c.staleAfterSec === 'number' ? c.staleAfterSec : 60,
    broker: parseBroker(c.broker, `meter-mqtt-phase '${String(c.name)}'`),
  }
}
