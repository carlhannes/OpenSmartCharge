// First-party module imports — explicit so the dependency graph is clear
import '../modules/charger-ocpp16/index.js'

import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { createLogger } from './logger.js'
import { loadPlugins } from './plugin-loader.js'
import { loadLoadpointStates, setLoadpointMode, setLoadpointTarget } from './loadpoint.js'
import { createEventBus } from './events.js'
import { createHealthMap, updateHealth } from './health.js'
import { getChargerModule } from '../sdk/registry-api.js'
import { getOcppServer } from '../modules/charger-ocpp16/index.js'
import { startServer } from '../server/index.js'
import { startMqttBridge } from '../server/mqtt-bridge.js'
import type { Charger } from '../sdk/charger.js'
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

  // Build charger lookup map by charger name
  const ctx = { db, events, log }
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

    // Apply persisted mode to charger on boot
    await applyMode(lpCfg.name, state.mode, charger, state.maxCurrentA)
  }

  // Control surface helpers (shared by REST + MQTT)
  async function handleModeChange(name: string, mode: ChargeMode): Promise<void> {
    const state = loadpointStates.get(name)
    if (!state) return
    state.mode = mode
    setLoadpointMode(db, name, mode)
    events.emit('loadpoint.mode', { name, mode })

    const charger = chargers.get(config.loadpoints.find((l) => l.name === name)?.charger ?? '')
    if (charger) await applyMode(name, mode, charger, state.maxCurrentA)
  }

  async function handleTargetChange(name: string, soc?: number, time?: string): Promise<void> {
    const state = loadpointStates.get(name)
    if (!state) return
    state.targetSoc = soc
    state.targetTime = time
    setLoadpointTarget(db, name, soc, time)
    events.emit('loadpoint.target', { name, targetSoc: soc, targetTime: time })
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
  })
  log.info({ port: config.site.port }, 'HTTP server listening')

  // Wire REST mode/target handlers that go through the shared handler
  // (the API router above calls setLoadpointMode directly, but we also need
  //  to wire the applyMode side-effect when mode changes via REST)
  events.on('loadpoint.mode', (payload) => {
    const p = payload as { name: string; mode: ChargeMode }
    // Already persisted in API handler; charger update also done there.
    // Just keep health fresh.
    const charger = chargers.get(config.loadpoints.find((l) => l.name === p.name)?.charger ?? '')
    if (charger) updateHealth(health, p.name, charger.health())
  })

  // Attach OCPP WS upgrade handler to the HTTP server, and tell the OCPP
  // server which loadpoint name maps to each stationId so transactions are
  // stored with the correct loadpoint_name.
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
      health,
      onModeChange: handleModeChange,
      onTargetChange: handleTargetChange,
    }, log)
    log.info({ host: config.mqtt.host }, 'MQTT bridge starting')
  }

  log.info('OpenSmartCharge ready')

  const shutdown = () => {
    log.info('shutting down gracefully')
    httpServer.close()
    if (ocppServer) void ocppServer.close()
    db.close()
    process.exit(0)
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

async function applyMode(
  name: string,
  mode: ChargeMode,
  charger: Charger,
  maxCurrentA: number,
): Promise<void> {
  try {
    if (mode === 'disabled') {
      await charger.setCurrentLimit(0)
    } else {
      // smart and fast both charge at max in M1 (no balancer yet)
      await charger.setCurrentLimit(maxCurrentA)
    }
  } catch {
    // Charger may not be connected yet — silently ignore
  }
}

main().catch((err) => {
  console.error('fatal startup error', err)
  process.exit(1)
})
