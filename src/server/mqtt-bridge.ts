import mqtt from 'mqtt'
import type { Logger } from 'pino'
import type { EventBus } from '../core/events.js'
import type { LoadpointState } from '../core/loadpoint.js'
import type { HealthMap } from '../core/health.js'
import type { ChargeMode } from '../core/config.js'
import type { Tariff } from '../sdk/tariff.js'
import type { Balancer } from '../sdk/balancer.js'
import type { Vehicle } from '../sdk/vehicle.js'
import { publishHaDiscovery } from './ha-discovery.js'

interface MqttConfig {
  host: string
  port: number
  user?: string
  password?: string
  topicPrefix: string
  homeAssistantDiscovery: boolean
}

export interface MqttBridgeDeps {
  events: EventBus
  loadpoints: Map<string, LoadpointState>
  tariffs: Map<string, Tariff>
  balancers: Map<string, Balancer>
  vehicles: Map<string, Vehicle>
  health: HealthMap
  onModeChange(name: string, mode: ChargeMode): Promise<void>
  onTargetChange(name: string, soc?: number, time?: string, kwh?: number): Promise<void>
}

export function startMqttBridge(config: MqttConfig, deps: MqttBridgeDeps, log: Logger): void {
  const client = mqtt.connect({
    host: config.host,
    port: config.port,
    username: config.user,
    password: config.password,
    clientId: `osc-bridge-${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
  })

  const prefix = config.topicPrefix

  client.on('connect', () => {
    log.info({ host: config.host, port: config.port }, 'MQTT bridge connected')

    // Publish initial state
    for (const state of deps.loadpoints.values()) {
      publishState(client, prefix, state)
    }

    // Subscribe to command topics
    const cmdTopics = [...deps.loadpoints.keys()].flatMap((name) => [
      `${prefix}/loadpoints/${name}/cmd/mode`,
      `${prefix}/loadpoints/${name}/cmd/target`,
    ])
    if (cmdTopics.length > 0) {
      client.subscribe(cmdTopics, (err) => {
        if (err) log.warn({ err }, 'MQTT subscribe failed')
      })
    }

    // Publish health (all modules including balancers)
    for (const [module, entry] of deps.health) {
      client.publish(`${prefix}/health/${module}`, entry.health, { retain: true })
    }

    // Publish initial balancer health
    for (const [name, balancer] of deps.balancers) {
      client.publish(`${prefix}/balancer/${name}/health`, balancer.health(), { retain: true })
    }

    // Publish initial vehicle health
    for (const [name, vehicle] of deps.vehicles) {
      client.publish(`${prefix}/vehicles/${name}/health`, vehicle.health(), { retain: true })
    }

    if (config.homeAssistantDiscovery) {
      publishHaDiscovery(client, [...deps.loadpoints.keys()], prefix)
    }

    // Publish current slot prices for all configured tariffs
    void publishTariffNow(client, prefix, deps.tariffs)
    scheduleHourlyTariffPublish(client, prefix, deps.tariffs)
  })

  client.on('error', (err) => {
    log.warn({ err }, 'MQTT bridge error')
  })

  client.on('message', (topic, payload) => {
    const str = payload.toString().trim()
    const parts = topic.split('/')
    // Expected: <prefix>/loadpoints/<name>/cmd/<command>
    const cmdIdx = parts.indexOf('cmd')
    if (cmdIdx < 0) return
    const name = parts[cmdIdx - 1]
    const command = parts[cmdIdx + 1]

    if (command === 'mode') {
      if (str !== 'smart' && str !== 'fast' && str !== 'disabled') {
        log.warn({ topic, str }, 'invalid mode command')
        return
      }
      deps
        .onModeChange(name, str as ChargeMode)
        .catch((err) => log.warn({ err }, 'MQTT mode change error'))
    } else if (command === 'target') {
      try {
        const body = JSON.parse(str) as { soc?: number; time?: string; kwh?: number }
        deps
          .onTargetChange(name, body.soc, body.time, body.kwh)
          .catch((err) => log.warn({ err }, 'MQTT target change error'))
      } catch {
        log.warn({ topic, str }, 'invalid target JSON')
      }
    }
  })

  // Mirror balancer tick results to MQTT
  deps.events.on('balancer.tick', (payload) => {
    const p = payload as {
      name: string
      allocations: Record<string, number>
      freeAmps: number
      health: string
    }
    client.publish(`${prefix}/balancer/${p.name}/health`, p.health, { retain: true })
    client.publish(`${prefix}/balancer/${p.name}/free_amps`, String(p.freeAmps), { retain: true })
    client.publish(`${prefix}/balancer/${p.name}/allocations`, JSON.stringify(p.allocations), {
      retain: true,
    })
  })

  // Re-publish current tariff price whenever new data lands
  deps.events.on('tariff.updated', (payload) => {
    const p = payload as { name: string }
    const tariff = deps.tariffs.get(p.name)
    if (tariff) void publishOneTariffNow(client, prefix, p.name, tariff)
  })

  // Publish vehicle SoC + health whenever a poll succeeds
  deps.events.on('vehicle.poll', (payload) => {
    const p = payload as { name: string; soc: number }
    const vehicle = deps.vehicles.get(p.name)
    if (!vehicle) return
    client.publish(`${prefix}/vehicles/${p.name}/soc`, String(p.soc), { retain: true })
    client.publish(`${prefix}/vehicles/${p.name}/health`, vehicle.health(), { retain: true })
  })

  // Mirror internal events to MQTT
  deps.events.on('loadpoint.state', (payload) => {
    const p = payload as { name: string }
    const state = deps.loadpoints.get(p.name)
    if (state) publishState(client, prefix, state)
  })

  deps.events.on('loadpoint.mode', (payload) => {
    const p = payload as { name: string; mode: string }
    client.publish(`${prefix}/loadpoints/${p.name}/mode`, p.mode, { retain: true })
    const state = deps.loadpoints.get(p.name)
    if (state) publishState(client, prefix, state)
  })

  deps.events.on('loadpoint.target', (payload) => {
    const p = payload as { name: string }
    const state = deps.loadpoints.get(p.name)
    if (state) publishState(client, prefix, state)
  })
}

function publishState(client: mqtt.MqttClient, prefix: string, state: LoadpointState): void {
  const lpPrefix = `${prefix}/loadpoints/${state.name}`
  client.publish(`${lpPrefix}/mode`, state.mode, { retain: true })
  client.publish(`${lpPrefix}/current_a`, String(state.currentA), { retain: true })
  client.publish(`${lpPrefix}/energy_kwh`, String(state.sessionEnergyKWh), { retain: true })
  client.publish(`${lpPrefix}/state`, JSON.stringify(state), { retain: true })
}

async function publishOneTariffNow(
  client: mqtt.MqttClient,
  prefix: string,
  name: string,
  tariff: Tariff,
): Promise<void> {
  const now = new Date()
  const slots = await tariff.prices(now, new Date(now.getTime() + 3600_000))
  const price = slots[0]?.pricePerKWh
  if (price !== undefined) {
    client.publish(`${prefix}/tariffs/${name}/now`, String(price), { retain: true })
  }
}

async function publishTariffNow(
  client: mqtt.MqttClient,
  prefix: string,
  tariffs: Map<string, Tariff>,
): Promise<void> {
  for (const [name, tariff] of tariffs) {
    await publishOneTariffNow(client, prefix, name, tariff)
  }
}

function scheduleHourlyTariffPublish(
  client: mqtt.MqttClient,
  prefix: string,
  tariffs: Map<string, Tariff>,
): void {
  // Re-publish at the top of each hour as the "now" slot advances
  const msUntilNextHour = 3600_000 - (Date.now() % 3600_000)
  setTimeout(() => {
    void publishTariffNow(client, prefix, tariffs)
    setInterval(() => void publishTariffNow(client, prefix, tariffs), 3600_000)
  }, msUntilNextHour)
}
