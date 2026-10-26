import type { MqttClient } from 'mqtt'
import type { Logger } from 'pino'
import { connectBroker, endBroker, type Broker } from '../../sdk/broker.js'
import { meterHealth, type MeterSnapshot } from '../../sdk/meter-reader.js'
import type { ModuleHealth } from '../../sdk/types.js'
import { extractMetrics } from './dsmr.js'

interface PulseClientOpts {
  broker: Broker
  subTopic: string
  ctrlTopics: string[]
  disablePayload: string
  disableIntervalSec: number
  staleAfterSec: number
  republishPrefix?: string
  log: Logger
  onSnapshot: (s: MeterSnapshot) => void
}

export interface PulseClientHandle {
  start(): Promise<void>
  stop(): Promise<void>
  latest(): MeterSnapshot | null
  health(): ModuleHealth
}

export function createPulseClient(opts: PulseClientOpts): PulseClientHandle {
  let latestSnapshot: MeterSnapshot | null = null
  let lastDisableMs = 0
  let lastLogMs = 0
  const stats = { msgs: 0, json: 0, text: 0, published: 0 }
  let mqttClient: MqttClient | undefined

  function disableBatching(c: MqttClient, reason: string): void {
    const now = Date.now()
    if (now - lastDisableMs < opts.disableIntervalSec * 1000) return
    for (const t of opts.ctrlTopics) {
      c.publish(t, opts.disablePayload, { qos: 0, retain: false })
    }
    lastDisableMs = now
    opts.log.info({ reason, topics: opts.ctrlTopics }, 'sent disable batching')
  }

  function republish(c: MqttClient, prefix: string, snap: MeterSnapshot): void {
    if (snap.powerW !== undefined)
      c.publish(`${prefix}/power_w`, String(snap.powerW), { qos: 0, retain: false })
    if (snap.i1A !== undefined)
      c.publish(`${prefix}/i1_a`, String(snap.i1A), { qos: 0, retain: false })
    if (snap.i2A !== undefined)
      c.publish(`${prefix}/i2_a`, String(snap.i2A), { qos: 0, retain: false })
    if (snap.i3A !== undefined)
      c.publish(`${prefix}/i3_a`, String(snap.i3A), { qos: 0, retain: false })
  }

  function handleMessage(c: MqttClient, payload: Buffer): void {
    stats.msgs++
    disableBatching(c, 'periodic')

    if (!payload || payload.length === 0) return

    const text = payload.toString('utf8')

    // JSON status frames start with '{' — counted, not parsed further (no DSMR data in them).
    if (payload[0] === 0x7b) {
      try {
        JSON.parse(text)
        stats.json++
        return
      } catch {
        /* fall through — not valid JSON, treat as text */
      }
    }

    // Require OBIS power marker — must be a DSMR frame
    if (!text.includes('1-0:1.7.0')) return

    stats.text++
    const metrics = extractMetrics(text)

    if (Object.keys(metrics).length > 0) {
      const snap: MeterSnapshot = { ...metrics, timestamp: new Date() }
      latestSnapshot = snap
      opts.onSnapshot(snap)

      if (opts.republishPrefix) {
        republish(c, opts.republishPrefix, snap)
        stats.published++
      }
    }

    const now = Date.now()
    if (now - lastLogMs >= 60_000) {
      lastLogMs = now
      opts.log.info({ stats, latest: latestSnapshot }, 'pulse bridge heartbeat')
    }
  }

  return {
    start(): Promise<void> {
      const c = connectBroker(opts.broker, 'pulse-bridge')
      mqttClient = c

      c.on('connect', () => {
        opts.log.info({ host: opts.broker.host, subTopic: opts.subTopic }, 'pulse bridge connected')
        c.subscribe(opts.subTopic, { qos: 0 }, (err) => {
          if (err) opts.log.warn({ err }, 'pulse subscribe failed')
        })
        lastDisableMs = 0
        disableBatching(c, 'startup')
      })

      c.on('disconnect', () => {
        opts.log.info('pulse bridge disconnected')
      })

      c.on('error', (err) => {
        opts.log.warn({ err }, 'pulse bridge error')
      })

      c.on('message', (_topic, payload) => {
        handleMessage(c, payload as Buffer)
      })

      return Promise.resolve()
    },

    stop: () => endBroker(mqttClient),
    latest: () => latestSnapshot,
    health: () => meterHealth(latestSnapshot, opts.staleAfterSec),
  }
}
