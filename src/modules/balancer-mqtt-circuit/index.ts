import mqtt from 'mqtt'
import { registerBalancer } from '../../sdk/registry-api.js'
import type { BalancerModule } from '../../sdk/balancer.js'
import type { MeterSnapshot } from '../../sdk/meter-reader.js'
import { parseConfig } from './types.js'
import { allocate } from './allocator.js'

const mod: BalancerModule = {
  type: 'mqtt-circuit',
  create(rawCfg, ctx) {
    const cfg = parseConfig(rawCfg)
    let latest: MeterSnapshot | null = null
    let latestMs = 0
    let unsub: (() => void) | null = null
    let client: ReturnType<typeof mqtt.connect> | null = null

    return {
      id: cfg.name,

      async start() {
        if (cfg.meterReader) {
          const onSnap = (payload: unknown) => {
            const p = payload as { name: string; snapshot: MeterSnapshot }
            if (p.name === cfg.meterReader) {
              latest = p.snapshot
              latestMs = Date.now()
            }
          }
          ctx.events.on('meter.snapshot', onSnap)
          unsub = () => ctx.events.off('meter.snapshot', onSnap)
          ctx.log.info({ meterReader: cfg.meterReader }, 'balancer wired to in-process meter reader')
        } else {
          if (!ctx.mqtt) {
            throw new Error(
              `balancer ${cfg.name}: meterReader not set and mqtt: is not configured in osc.yaml`,
            )
          }
          const prefix = cfg.meterTopicPrefix
          client = mqtt.connect({
            host: ctx.mqtt.host,
            port: ctx.mqtt.port,
            username: ctx.mqtt.user,
            password: ctx.mqtt.password,
            clientId: `osc-balancer-${Math.random().toString(16).slice(2, 8)}`,
            clean: true,
          })
          const phaseCurrents = { i1: 0, i2: 0, i3: 0 }
          client.on('connect', () => {
            ctx.log.info({ host: ctx.mqtt!.host, prefix }, 'balancer MQTT subscribed to phase currents')
            client!.subscribe([`${prefix}/i1_a`, `${prefix}/i2_a`, `${prefix}/i3_a`], { qos: 0 }, (err) => {
              if (err) ctx.log.warn({ err }, 'balancer MQTT subscribe failed')
            })
          })
          client.on('message', (topic, payload) => {
            const val = parseFloat(payload.toString())
            if (!isFinite(val)) return
            const key = topic.endsWith('i1_a') ? 'i1' : topic.endsWith('i2_a') ? 'i2' : 'i3'
            phaseCurrents[key] = val
            latest = {
              i1A: phaseCurrents.i1,
              i2A: phaseCurrents.i2,
              i3A: phaseCurrents.i3,
              timestamp: new Date(),
            }
            latestMs = Date.now()
          })
          client.on('error', (err) => {
            ctx.log.warn({ err }, 'balancer MQTT error')
          })
        }
      },

      async stop() {
        unsub?.()
        if (client) {
          await new Promise<void>((resolve) => client!.end(false, {}, () => resolve()))
        }
      },

      health() {
        if (!latest) return 'unavailable'
        return Date.now() - latestMs < cfg.meterStaleAfterSec * 1000 ? 'ok' : 'degraded'
      },

      async tick(input) {
        const stale = !latest || Date.now() - latestMs >= cfg.meterStaleAfterSec * 1000
        const phases = latest
          ? { i1: latest.i1A ?? 0, i2: latest.i2A ?? 0, i3: latest.i3A ?? 0 }
          : null
        const { allocations, freeAmps } = allocate({
          loadpoints: input.loadpoints,
          mainBreakerA: cfg.mainBreakerA,
          phaseCurrentsA: phases,
          meterStale: stale,
          safeStaticCurrentA: cfg.safeStaticCurrentA,
        })
        return { allocations, freeAmps }
      },
    }
  },
}

registerBalancer(mod)
