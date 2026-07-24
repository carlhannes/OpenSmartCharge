import { registerMeterReader } from '../../sdk/registry-api.js'
import type { MeterSnapshot, MeterReader } from '../../sdk/meter-reader.js'
import { createPulseClient } from './client.js'
import { parseConfig } from './types.js'

registerMeterReader({
  type: 'tibber-pulse',
  create(cfg, ctx) {
    const c = parseConfig(cfg) // throws if `broker` is missing — this reader owns its connection
    const subscribers = new Set<(s: MeterSnapshot) => void>()
    const client = createPulseClient({
      broker: c.broker,
      subTopic: c.subTopic,
      ctrlTopics: c.ctrlTopics,
      disablePayload: c.disablePayload,
      disableIntervalSec: c.disableIntervalSec,
      staleAfterSec: c.staleAfterSec,
      republishPrefix: c.republishPrefix,
      log: ctx.log,
      onSnapshot: (s) => {
        ctx.events.emit('meter.snapshot', { name: c.name, snapshot: s })
        for (const cb of subscribers) cb(s)
      },
    })
    const reader: MeterReader = {
      id: c.name,
      start: () => client.start(),
      stop: () => client.stop(),
      health: () => client.health(),
      latest: () => client.latest(),
      onSnapshot: (cb) => {
        subscribers.add(cb)
        return () => {
          subscribers.delete(cb)
        }
      },
    }
    return reader
  },
})
