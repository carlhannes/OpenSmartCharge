import mqtt from 'mqtt'
import { registerMeterReader } from '../../sdk/registry-api.js'
import type { MeterSnapshot, MeterReader } from '../../sdk/meter-reader.js'
import type { ModuleHealth } from '../../sdk/types.js'
import { parseConfig } from './types.js'
import { applyPhaseMessage, type PhaseCurrents } from './parse.js'

/**
 * A MeterReader for the raw per-phase current feed on MQTT — `{topicPrefix}/i{1,2,3}_a`, as
 * published by pulse_bridge.py or any DSMR/Modbus bridge. This is the SSoT home for the legacy
 * balancer `meterTopicPrefix` path: the balancer is now a pure splitter, so a circuit that used
 * raw topics points its `meterReader:` at one of these instead. For a Tibber Pulse that speaks
 * DSMR directly, prefer `type: tibber-pulse` (richer frames); use this for a plain phase feed.
 */
registerMeterReader({
  type: 'mqtt-phase',
  create(cfg, ctx) {
    const c = parseConfig(cfg) // throws if `broker` is missing — this reader owns its connection
    const subscribers = new Set<(s: MeterSnapshot) => void>()
    const acc: PhaseCurrents = { i1A: 0, i2A: 0, i3A: 0 }
    let latest: MeterSnapshot | null = null
    let client: ReturnType<typeof mqtt.connect> | null = null

    const reader: MeterReader = {
      id: c.name,

      start() {
        const topics = [`${c.topicPrefix}/i1_a`, `${c.topicPrefix}/i2_a`, `${c.topicPrefix}/i3_a`]
        const conn = mqtt.connect({
          host: c.broker.host,
          port: c.broker.port,
          username: c.broker.user,
          password: c.broker.password,
          clientId: `osc-meter-phase-${Math.random().toString(16).slice(2, 8)}`,
          clean: true,
        })
        client = conn
        conn.on('connect', () => {
          ctx.log.info({ host: c.broker.host, topics }, 'meter-mqtt-phase subscribed')
          conn.subscribe(topics, { qos: 0 }, (err) => {
            if (err) ctx.log.warn({ err }, 'meter-mqtt-phase subscribe failed')
          })
        })
        conn.on('message', (topic, payload) => {
          const snap = applyPhaseMessage(acc, topic, payload.toString(), new Date())
          if (!snap) return
          latest = snap
          ctx.events.emit('meter.snapshot', { name: c.name, snapshot: snap })
          for (const sub of subscribers) sub(snap)
        })
        conn.on('error', (err) => {
          ctx.log.warn({ err }, 'meter-mqtt-phase error')
        })
        return Promise.resolve()
      },

      stop() {
        return new Promise<void>((resolve) => {
          if (client) client.end(false, {}, () => resolve())
          else resolve()
        })
      },

      health(): ModuleHealth {
        if (!latest) return 'unavailable'
        return Date.now() - latest.timestamp.getTime() < c.staleAfterSec * 1000 ? 'ok' : 'degraded'
      },

      latest: () => latest,

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
