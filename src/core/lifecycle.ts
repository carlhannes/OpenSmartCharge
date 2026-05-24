// First-party module imports — explicit so the dependency graph is clear
import '../modules/charger-ocpp16/index.js'
import '../modules/tariff-elering/index.js'
import '../modules/meter-tibber-pulse/index.js'
import '../modules/balancer-mqtt-circuit/index.js'

import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { createLogger } from './logger.js'
import { loadPlugins } from './plugin-loader.js'
import { loadLoadpointStates, setLoadpointMode, setLoadpointTarget } from './loadpoint.js'
import { createEventBus } from './events.js'
import { createHealthMap, updateHealth } from './health.js'
import {
  getChargerModule,
  getTariffModule,
  getMeterReaderModule,
  getBalancerModule,
} from '../sdk/registry-api.js'
import { getOcppServer } from '../modules/charger-ocpp16/index.js'
import { startServer } from '../server/index.js'
import { startMqttBridge } from '../server/mqtt-bridge.js'
import { plan } from './planner.js'
import type { Charger } from '../sdk/charger.js'
import type { Tariff } from '../sdk/tariff.js'
import type { MeterReader } from '../sdk/meter-reader.js'
import type { Balancer, LoadpointSnapshot } from '../sdk/balancer.js'
import type { LoadpointState } from './loadpoint.js'
import type { ChargeMode } from './config.js'

const CONFIG_PATH = process.env.OSC_CONFIG ?? './osc.yaml'
const DATA_DIR = process.env.OSC_DATA_DIR ?? './data'
const PLUGINS_DIR = process.env.OSC_PLUGINS_DIR ?? './plugins'

async function main() {
  const log = createLogger()
  log.info('OpenSmartCharge starting')

  const config = loadConfig(CONFIG_PATH)
  log.info({ site: config.site.name, port: config.site.port }, 'config loaded')

  const db = openDb(DATA_DIR)
  log.info({ dataDir: DATA_DIR }, 'database ready')

  const events = createEventBus()
  const health = createHealthMap()

  await loadPlugins(PLUGINS_DIR, log)

  // ctx.fetch is a drop-in fetch() replacement with 0-120s random jitter.
  // Modules use it for scheduled outbound HTTP calls to prevent all instances
  // from hitting the same external endpoint at the same millisecond.
  const jitterFetch: typeof globalThis.fetch = async (input, init) => {
    const jitter = Math.floor(Math.random() * 120_000)
    await new Promise<void>((resolve) => setTimeout(resolve, jitter))
    return fetch(input, init)
  }

  // Build charger lookup map by charger name
  const ctx = {
    db,
    events,
    log,
    fetch: jitterFetch,
    mqtt: config.mqtt
      ? { host: config.mqtt.host, port: config.mqtt.port, user: config.mqtt.user, password: config.mqtt.password }
      : undefined,
  }
  const chargers = new Map<string, Charger>()

  for (const chargerCfg of config.chargers) {
    const mod = getChargerModule(chargerCfg.type)
    if (!mod) {
      log.warn({ type: chargerCfg.type, name: chargerCfg.name }, 'no module registered for charger type')
      continue
    }
    const charger = mod.create(chargerCfg, ctx)
    await charger.start()
    chargers.set(chargerCfg.name, charger)
    updateHealth(health, chargerCfg.name, charger.health())
    log.info({ charger: chargerCfg.name, type: chargerCfg.type }, 'charger module created')
  }

  // Instantiate tariff modules
  const tariffs = new Map<string, Tariff>()
  for (const tariffCfg of config.tariffs) {
    const mod = getTariffModule(tariffCfg.type)
    if (!mod) {
      log.warn({ type: tariffCfg.type, name: tariffCfg.name }, 'no module registered for tariff type')
      continue
    }
    const tariff = mod.create(tariffCfg, ctx)
    await tariff.start()
    tariffs.set(tariffCfg.name, tariff)
    updateHealth(health, tariffCfg.name, tariff.health())
    log.info({ tariff: tariffCfg.name, type: tariffCfg.type }, 'tariff module created')
  }

  events.on('tariff.updated', (payload) => {
    const p = payload as { name: string }
    const t = tariffs.get(p.name)
    if (t) updateHealth(health, p.name, t.health())
  })

  // Instantiate meter reader modules
  const meterReaders = new Map<string, MeterReader>()
  for (const meterCfg of config.meterReaders) {
    const mod = getMeterReaderModule(meterCfg.type)
    if (!mod) {
      log.warn({ type: meterCfg.type, name: meterCfg.name }, 'no module registered for meter reader type')
      continue
    }
    const reader = mod.create(meterCfg, ctx)
    await reader.start()
    meterReaders.set(meterCfg.name, reader)
    updateHealth(health, meterCfg.name, reader.health())
    log.info({ meter: meterCfg.name, type: meterCfg.type }, 'meter reader module created')
  }

  events.on('meter.snapshot', (payload) => {
    const p = payload as { name: string }
    const r = meterReaders.get(p.name)
    if (r) updateHealth(health, p.name, r.health())
  })

  // Instantiate balancer modules
  const balancers = new Map<string, Balancer>()
  for (const balancerCfg of config.balancers) {
    const mod = getBalancerModule(balancerCfg.type)
    if (!mod) {
      log.warn({ type: balancerCfg.type, name: balancerCfg.name }, 'no module registered for balancer type')
      continue
    }
    const balancer = mod.create(balancerCfg, ctx)
    await balancer.start()
    balancers.set(balancerCfg.name, balancer)
    updateHealth(health, balancerCfg.name, balancer.health())
    log.info({ balancer: balancerCfg.name, type: balancerCfg.type }, 'balancer module created')
  }

  // Determine maxA per loadpoint from the charger config
  const loadpointInits = config.loadpoints.map((lp) => {
    const chargerCfg = config.chargers.find((c) => c.name === lp.charger)
    return {
      name: lp.name,
      maxCurrentA: (chargerCfg as { maxA?: number } | undefined)?.maxA ?? 16,
      autoStart: lp.autoStart,
    }
  })

  const loadpointStates = loadLoadpointStates(db, loadpointInits)
  log.info({ loadpoints: [...loadpointStates.keys()] }, 'loadpoints initialized')

  // Wire charger status events → loadpoint state → event bus
  for (const lpCfg of config.loadpoints) {
    const charger = chargers.get(lpCfg.charger)
    if (!charger) continue

    const state = loadpointStates.get(lpCfg.name)!

    charger.onStatus((status) => {
      state.connected = status.connected
      state.charging = status.charging
      state.currentA = status.currentA ?? state.currentA
      state.sessionEnergyKWh = status.sessionEnergyKWh ?? state.sessionEnergyKWh

      // Persist energy for estimation when vehicle is offline
      events.emit('loadpoint.state', {
        name: state.name,
        connected: state.connected,
        charging: state.charging,
        currentA: state.currentA,
        sessionEnergyKWh: state.sessionEnergyKWh,
      })
    })
  }

  // Control surface helpers (shared by REST + MQTT)
  async function handleModeChange(name: string, mode: ChargeMode): Promise<void> {
    const state = loadpointStates.get(name)
    if (!state) return
    state.mode = mode
    setLoadpointMode(db, name, mode)
    events.emit('loadpoint.mode', { name, mode })

    // Trigger an immediate balancer tick so the charger responds within ~1 s
    // rather than waiting up to intervalSec
    const lpCfg = config.loadpoints.find((l) => l.name === name)
    if (lpCfg?.balancer) {
      void runBalancerTick(lpCfg.balancer)
    } else if (mode === 'disabled') {
      // No balancer configured; apply 0 directly
      const charger = chargers.get(lpCfg?.charger ?? '')
      if (charger) await charger.setCurrentLimit(0).catch(() => {})
    } else {
      // No balancer: apply max for smart/fast
      const charger = chargers.get(lpCfg?.charger ?? '')
      if (charger) await charger.setCurrentLimit(state.maxCurrentA).catch(() => {})
    }
  }

  async function handleTargetChange(name: string, soc?: number, time?: string): Promise<void> {
    const state = loadpointStates.get(name)
    if (!state) return
    state.targetSoc = soc
    state.targetTime = time
    setLoadpointTarget(db, name, soc, time)
    events.emit('loadpoint.target', { name, targetSoc: soc, targetTime: time })
  }

  // Build a LoadpointSnapshot from live state.
  // shouldChargeNow is pre-computed by the tariff gate for smart-mode loadpoints.
  function buildSnapshot(state: LoadpointState, shouldChargeNow?: boolean, pricesAvailable = false): LoadpointSnapshot {
    return {
      id: state.name,
      mode: state.mode,
      connected: state.connected,
      charging: state.charging,
      currentA: state.currentA,
      sessionEnergyKWh: state.sessionEnergyKWh,
      targetSoc: state.targetSoc,
      targetTime: state.targetTime ? parseTargetTime(state.targetTime) : undefined,
      maxCurrentA: state.maxCurrentA,
      pricesAvailable,
      shouldChargeNow,
    }
  }

  // Decide whether a smart-mode loadpoint should be charging in the current slot.
  // Uses the planner to pick cheapest slots; degrades to true when no tariff data.
  async function computeShouldChargeNow(lpName: string): Promise<boolean> {
    const state = loadpointStates.get(lpName)
    if (!state) return true
    const lpCfg = config.loadpoints.find((l) => l.name === lpName)
    if (!lpCfg?.tariff) return true
    const tariff = tariffs.get(lpCfg.tariff)
    if (!tariff || tariff.health() === 'unavailable') return true

    const now = new Date()
    const targetTime = state.targetTime ? parseTargetTime(state.targetTime) : new Date(Date.now() + 24 * 3600_000)
    const hoursUntilTarget = Math.max(0.25, (targetTime.getTime() - now.getTime()) / 3_600_000)

    let priceSlots
    try {
      priceSlots = await tariff.prices(now, targetTime)
    } catch {
      return true
    }
    if (!priceSlots || priceSlots.length === 0) return true

    // Heuristic requiredKWh: assume 40% duty cycle on maxCurrentA (refined in M4 with real SoC)
    const chargeRateKW = (state.maxCurrentA * 3 * 230) / 1000
    const requiredKWh = Math.max(1, hoursUntilTarget * chargeRateKW * 0.4)

    const planned = plan({ requiredKWh, targetTime, maxCurrentA: state.maxCurrentA, phases: 3, priceSlots })
    const currentSlot = planned.find((s) => s.start <= now && s.end > now)
    return currentSlot?.shouldCharge ?? true
  }

  // Tick function for a specific balancer — called on the interval and on mode changes.
  const lastTickByBalancer = new Map<string, { allocations: Record<string, number>; freeAmps: number }>()

  async function runBalancerTick(balancerName: string): Promise<void> {
    const balancer = balancers.get(balancerName)
    if (!balancer) return

    const lpCfgs = config.loadpoints.filter((l) => l.balancer === balancerName)
    const snaps = await Promise.all(
      lpCfgs.map(async (lpCfg) => {
        const state = loadpointStates.get(lpCfg.name)!
        const should = state.mode === 'smart' ? await computeShouldChargeNow(lpCfg.name) : undefined
        const tariff = lpCfg.tariff ? tariffs.get(lpCfg.tariff) : undefined
        const pricesAvailable = !!tariff && tariff.health() !== 'unavailable'
        return buildSnapshot(state, should, pricesAvailable)
      }),
    )

    const out = await balancer.tick({ loadpoints: snaps, timestamp: new Date() })

    for (const [lpId, amps] of out.allocations) {
      const charger = chargerLimitMap.get(lpId)
      if (charger) await charger.setCurrentLimit(amps).catch(() => {})
    }

    const allocRecord = Object.fromEntries(out.allocations)
    const maxPhase = Math.max(...snaps.map((s) => s.currentA), 0)
    const balancerCfg = config.balancers.find((b) => b.name === balancerName)
    const freeAmps = Math.max(0, (balancerCfg?.mainBreakerA ?? 0) - maxPhase)
    lastTickByBalancer.set(balancerName, { allocations: allocRecord, freeAmps })

    events.emit('balancer.tick', {
      name: balancerName,
      allocations: allocRecord,
      freeAmps,
      health: balancer.health(),
    })
    updateHealth(health, balancerName, balancer.health())
  }

  // HTTP server (REST + SSE)
  const chargerLimitMap = new Map<string, { setCurrentLimit(a: number): Promise<void> }>()
  for (const lpCfg of config.loadpoints) {
    const charger = chargers.get(lpCfg.charger)
    if (charger) chargerLimitMap.set(lpCfg.name, charger)
  }

  const httpServer = startServer(config.site.port, {
    db,
    events,
    health,
    loadpoints: loadpointStates,
    chargers: chargerLimitMap,
    tariffs,
    meterReaders,
    balancers,
    lastTickByBalancer,
    onModeChange: handleModeChange,
    onTargetChange: handleTargetChange,
  })
  log.info({ port: config.site.port }, 'HTTP server listening')

  // Wire REST mode/target handlers
  events.on('loadpoint.mode', (payload) => {
    const p = payload as { name: string; mode: ChargeMode }
    const charger = chargers.get(config.loadpoints.find((l) => l.name === p.name)?.charger ?? '')
    if (charger) updateHealth(health, p.name, charger.health())
  })

  // Attach OCPP WS upgrade handler to the HTTP server
  const ocppServer = getOcppServer()
  if (ocppServer) {
    for (const lpCfg of config.loadpoints) {
      const chargerCfg = config.chargers.find((c) => c.name === lpCfg.charger)
      if (chargerCfg) {
        const stationId = (chargerCfg as { stationId?: string }).stationId
        if (stationId) ocppServer.setLoadpointName(stationId, lpCfg.name)
      }
    }
    httpServer.on('upgrade', ocppServer.handleUpgrade)
    log.info('OCPP WebSocket endpoint ready at /ocpp/<stationId>')
  }

  // MQTT bridge (optional)
  if (config.mqtt) {
    startMqttBridge(config.mqtt, {
      events,
      loadpoints: loadpointStates,
      tariffs,
      balancers,
      health,
      onModeChange: handleModeChange,
      onTargetChange: handleTargetChange,
    }, log)
    log.info({ host: config.mqtt.host }, 'MQTT bridge starting')
  }

  // Start per-balancer tick loops
  const balancerIntervals: ReturnType<typeof setInterval>[] = []
  for (const balancerCfg of config.balancers) {
    if (!balancers.has(balancerCfg.name)) continue
    void runBalancerTick(balancerCfg.name) // immediate first tick
    balancerIntervals.push(
      setInterval(() => void runBalancerTick(balancerCfg.name), balancerCfg.intervalSec * 1000),
    )
    log.info({ balancer: balancerCfg.name, intervalSec: balancerCfg.intervalSec }, 'balancer tick loop started')
  }

  log.info('OpenSmartCharge ready')

  const shutdown = () => {
    log.info('shutting down gracefully')
    for (const t of balancerIntervals) clearInterval(t)
    httpServer.close()
    if (ocppServer) void ocppServer.close()
    for (const b of balancers.values()) void b.stop()
    for (const t of tariffs.values()) void t.stop()
    for (const r of meterReaders.values()) void r.stop()
    db.close()
    process.exit(0)
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

// Parse "HH:MM" into the next occurrence of that local time (today or tomorrow).
function parseTargetTime(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  if (d <= new Date()) d.setDate(d.getDate() + 1)
  return d
}

main().catch((err) => {
  console.error('fatal startup error', err)
  process.exit(1)
})
