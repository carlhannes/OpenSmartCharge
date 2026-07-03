export interface PulseConfig {
  name: string
  type: string
  subTopic: string
  ctrlTopics: string[]
  disablePayload: string
  disableIntervalSec: number
  staleAfterSec: number
  republishPrefix?: string
}

export function parseConfig(cfg: unknown): PulseConfig {
  const c = cfg as Record<string, unknown>
  if (typeof c.name !== 'string') throw new Error('meterReader config missing name')
  return {
    name: c.name,
    type: typeof c.type === 'string' ? c.type : 'tibber-pulse',
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
