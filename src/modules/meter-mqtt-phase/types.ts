export interface MqttPhaseConfig {
  name: string
  type: string
  /** Topic prefix for the raw per-phase current feed: subscribes to `{prefix}/i{1,2,3}_a`. */
  topicPrefix: string
  /** A snapshot older than this is reported `degraded` by health() — the ONE staleness authority. */
  staleAfterSec: number
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
  }
}
