// First-party module imports — explicit so the dependency graph is clear
import '../modules/charger-ocpp16/index.js'
import '../modules/tariff-elering/index.js'
import '../modules/tariff-elprisetjustnu/index.js'
import '../modules/meter-tibber-pulse/index.js'
import '../modules/balancer-mqtt-circuit/index.js'
import '../modules/vehicle-skoda/index.js'

import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { createLogger } from './logger.js'
import { loadPlugins } from './plugin-loader.js'
import {
  loadLoadpointStates,
  setLoadpointMode,
  setLoadpointTarget,
  foldChargerStatus,
} from './loadpoint.js'
import { createEventBus } from './events.js'
import { createHealthMap, updateHealth } from './health.js'
import {
  getChargerModule,
  getTariffModule,
  getMeterReaderModule,
  getBalancerModule,
  getVehicleModule,
} from '../sdk/registry-api.js'
import { getOcppServer } from '../modules/charger-ocpp16/index.js'
import { startServer } from '../server/index.js'
import { startMqttBridge } from '../server/mqtt-bridge.js'
import type { Charger } from '../sdk/charger.js'
import type { Tariff, TariffSlot } from '../sdk/tariff.js'
import type { MeterReader, MeterSnapshot } from '../sdk/meter-reader.js'
import { recordHouseholdLoad, pruneHouseholdLoad, worstCaseLoadA } from './smart-charging/rollup.js'
import { stockholmDateKey, stockholmHour, msUntilStockholmTime } from '../sdk/stockholm-time.js'
import type { Balancer, LoadpointSnapshot } from '../sdk/balancer.js'
import type { Vehicle } from '../sdk/vehicle.js'
import type { LoadpointState } from './loadpoint.js'
import type { ChargeMode, LoadpointConfig } from './config.js'
import { estimateSocSinceAnchor } from './estimator.js'
import { resolveEnergyTarget } from './smart-charging/energy.js'
import { resolvePriceCurve } from './smart-charging/price.js'
import { resolveCurrentBudget } from './smart-charging/current.js'
import { decideShouldCharge } from './smart-charging/decide.js'
import { shouldPollVehicle } from './smart-charging/vehicle-poll.js'
import {
  buildCircuits,
  circuitForLoadpoint,
  planCircuit,
  type Circuit,
  type LpDecision,
} from './control-loop.js'

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
      ? {
          host: config.mqtt.host,
          port: config.mqtt.port,
          user: config.mqtt.user,
          password: config.mqtt.password,
        }
      : undefined,
  }
  const chargers = new Map<string, Charger>()

  for (const chargerCfg of config.chargers) {
    const mod = getChargerModule(chargerCfg.type)
    if (!mod) {
      log.warn(
        { type: chargerCfg.type, name: chargerCfg.name },
        'no module registered for charger type',
      )
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
      log.warn(
        { type: tariffCfg.type, name: tariffCfg.name },
        'no module registered for tariff type',
      )
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
      log.warn(
        { type: meterCfg.type, name: meterCfg.name },
        'no module registered for meter reader type',
      )
      continue
    }
    const reader = mod.create(meterCfg, ctx)
    await reader.start()
    meterReaders.set(meterCfg.name, reader)
    updateHealth(health, meterCfg.name, reader.health())
    log.info({ meter: meterCfg.name, type: meterCfg.type }, 'meter reader module created')
  }

  // Track the last Stockholm day we pruned the load rollup, so pruning runs once per day
  // (on rollover) rather than on the ~1 Hz meter-event path.
  let lastRollupPruneDay: string | undefined
  events.on('meter.snapshot', (payload) => {
    const p = payload as { name: string; snapshot: MeterSnapshot }
    const r = meterReaders.get(p.name)
    if (r) updateHealth(health, p.name, r.health())

    // Fold whole-house load into the hourly-max rollup (feeds the historical current fallback).
    const s = p.snapshot
    const maxPhaseA = Math.max(s.i1A ?? 0, s.i2A ?? 0, s.i3A ?? 0)
    if (maxPhaseA > 0) {
      recordHouseholdLoad(db, s.timestamp, maxPhaseA)
      const dayKey = stockholmDateKey(s.timestamp)
      if (dayKey !== lastRollupPruneDay) {
        lastRollupPruneDay = dayKey
        // Keep a few days beyond the look-back window so the query range is always covered.
        pruneHouseholdLoad(db, s.timestamp, config.smartCharging.historicalDays + 4)
      }
    }
  })

  // Instantiate vehicle modules
  const vehicles = new Map<string, Vehicle>()
  for (const vCfg of config.vehicles) {
    const mod = getVehicleModule(vCfg.type)
    if (!mod) {
      log.warn({ type: vCfg.type, name: vCfg.name }, 'no module registered for vehicle type')
      continue
    }
    const vehicle = mod.create(vCfg, ctx)
    // No start() — the module owns no poll timer. The control loop drives vehicle.refresh()
    // on charger-connect + during charging (see maybePollVehicle).
    vehicles.set(vCfg.name, vehicle)
    updateHealth(health, vCfg.name, vehicle.health())
    log.info({ vehicle: vCfg.name, type: vCfg.type }, 'vehicle module created')
  }

  // Warn about loadpoints that reference a vehicle name no module provided.
  // Likely cause: typo in osc.yaml; falls back to duty-cycle planning silently.
  for (const lpCfg of config.loadpoints) {
    if (lpCfg.vehicle && !vehicles.has(lpCfg.vehicle)) {
      log.warn(
        { loadpoint: lpCfg.name, vehicle: lpCfg.vehicle },
        'loadpoint references unknown vehicle — SoC integration disabled for this loadpoint',
      )
    }
  }

  // Instantiate balancer modules
  const balancers = new Map<string, Balancer>()
  for (const balancerCfg of config.balancers) {
    const mod = getBalancerModule(balancerCfg.type)
    if (!mod) {
      log.warn(
        { type: balancerCfg.type, name: balancerCfg.name },
        'no module registered for balancer type',
      )
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
      defaultMode: lp.defaultMode,
      targetSoc: lp.targetSoc,
      targetTime: lp.targetTime,
      targetKWh: lp.targetKWh,
    }
  })

  const loadpointStates = loadLoadpointStates(db, loadpointInits)
  log.info({ loadpoints: [...loadpointStates.keys()] }, 'loadpoints initialized')

  // Group loadpoints into circuits once (balancer-shared vs bare). The single control loop
  // ticks every circuit regardless of whether a balancer is configured.
  const circuits = buildCircuits(config)

  // Wire charger status events → loadpoint state → event bus
  for (const lpCfg of config.loadpoints) {
    const charger = chargers.get(lpCfg.charger)
    if (!charger) continue

    const state = loadpointStates.get(lpCfg.name)!

    charger.onStatus((status) => {
      Object.assign(state, foldChargerStatus(state, status))

      // Charger module health tracks connection state — refresh on connect/disconnect.
      updateHealth(health, lpCfg.charger, charger.health())

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

    // Tick this loadpoint's circuit immediately so the charger responds within ~1 s rather
    // than waiting for the next control interval. The tick governs current for ALL modes —
    // there is no longer a no-balancer "just apply max" path (which made smart mode ignore
    // price whenever no balancer was configured).
    const circuit = circuitForLoadpoint(circuits, name)
    if (circuit) void circuitTick(circuit)
  }

  async function handleTargetChange(
    name: string,
    soc?: number,
    time?: string,
    kwh?: number,
  ): Promise<void> {
    const state = loadpointStates.get(name)
    if (!state) return
    state.targetSoc = soc
    state.targetTime = time
    state.targetKWh = kwh
    setLoadpointTarget(db, name, soc, time, kwh)
    events.emit('loadpoint.target', { name, targetSoc: soc, targetTime: time, targetKWh: kwh })
    // A new target changes the plan — tick the circuit now instead of waiting for the interval.
    const circuit = circuitForLoadpoint(circuits, name)
    if (circuit) void circuitTick(circuit)
  }

  // Last amps value successfully sent to each charger. Keyed by loadpoint name (= LoadpointSnapshot.id).
  // Used to give the allocator an accurate credit-back during the car's ramp-up period.
  const lastCommandedA = new Map<string, number>()

  // Lifecycle-owned vehicle polling (the module owns no timer). Per loadpoint: when we last polled
  // + whether we've polled since this connection began; and the SoC "anchor" — a real reading +
  // the session energy at that moment — so the estimate carries it forward by kWh delivered SINCE,
  // instead of double-counting the whole session on top of a mid-session reading.
  const vehiclePollState = new Map<string, { lastPollAt: number; polledThisConnection: boolean }>()
  const vehicleAnchor = new Map<string, { soc: number; sessionEnergyKWh: number }>()

  // Re-anchored SoC estimate: last real SoC + (session kWh since that reading) × efficiency / capacity.
  function estimatedSocFor(
    lpName: string,
    capacity: number | undefined,
    sessionEnergyKWh: number,
  ): number | undefined {
    const anchor = vehicleAnchor.get(lpName)
    if (!anchor) return undefined
    return estimateSocSinceAnchor(
      anchor.soc,
      anchor.sessionEnergyKWh,
      sessionEnergyKWh,
      capacity,
      config.smartCharging.chargingEfficiency,
    )
  }

  // Poll gate: refresh a loadpoint's vehicle on (re)connect + during charging every
  // vehiclePollIntervalSec; never while idle. Fire-and-forget — the fresh reading + its anchor are
  // used from the next tick.
  function maybePollVehicle(lpCfg: LoadpointConfig, state: LoadpointState, nowMs: number): void {
    if (!lpCfg.vehicle) return
    const vehicle = vehicles.get(lpCfg.vehicle)
    if (!vehicle) return
    const vp = vehiclePollState.get(lpCfg.name) ?? { lastPollAt: 0, polledThisConnection: false }
    if (!state.connected) {
      vp.polledThisConnection = false // reset so the next connection re-anchors on its first tick
      vehiclePollState.set(lpCfg.name, vp)
      return
    }
    const should = shouldPollVehicle({
      now: nowMs,
      connected: state.connected,
      charging: state.charging,
      lastPollAt: vp.lastPollAt,
      intervalMs: config.smartCharging.vehiclePollIntervalSec * 1000,
      polledThisConnection: vp.polledThisConnection,
    })
    if (!should) {
      vehiclePollState.set(lpCfg.name, vp)
      return
    }
    vp.lastPollAt = nowMs
    vp.polledThisConnection = true
    vehiclePollState.set(lpCfg.name, vp)
    const vehicleName = lpCfg.vehicle
    void vehicle
      .refresh()
      .then((data) => {
        vehicleAnchor.set(lpCfg.name, { soc: data.soc, sessionEnergyKWh: state.sessionEnergyKWh })
        updateHealth(health, vehicleName, vehicle.health())
      })
      .catch((err) => log.warn({ err, vehicle: vehicleName }, 'vehicle refresh failed'))
  }

  // Build a LoadpointSnapshot from live state.
  // shouldChargeNow is pre-computed by the tariff gate for smart-mode loadpoints.
  function buildSnapshot(
    state: LoadpointState,
    lpCfgVehicle: string | undefined,
    shouldChargeNow?: boolean,
    pricesAvailable = false,
  ): LoadpointSnapshot {
    let estimatedSocVal: number | undefined
    if (lpCfgVehicle) {
      const v = vehicles.get(lpCfgVehicle)
      if (v)
        estimatedSocVal = estimatedSocFor(state.name, v.getCachedCapacity(), state.sessionEnergyKWh)
    }
    return {
      id: state.name,
      mode: state.mode,
      connected: state.connected,
      charging: state.charging,
      currentA: state.currentA,
      commandedA: lastCommandedA.get(state.name),
      sessionEnergyKWh: state.sessionEnergyKWh,
      estimatedSoc: estimatedSocVal,
      targetSoc: state.targetSoc,
      targetTime: state.targetTime ? parseTargetTime(state.targetTime) : undefined,
      maxCurrentA: state.maxCurrentA,
      pricesAvailable,
      shouldChargeNow,
    }
  }

  // Freshest household load (max phase current) from any meter reader with a recent snapshot.
  // Feeds the current resolver's live rung — independent of whether a balancer is configured.
  function freshMeterMaxPhaseA(now: Date): number | undefined {
    for (const r of meterReaders.values()) {
      const s = r.latest()
      if (s && now.getTime() - s.timestamp.getTime() < 60_000) {
        return Math.max(s.i1A ?? 0, s.i2A ?? 0, s.i3A ?? 0)
      }
    }
    return undefined
  }

  // Average price per Stockholm hour-of-day over the last N days (price fallback rung). Reuses
  // the tariff's own cache via prices() — no zone plumbing needed. Only computed when live
  // prices are missing.
  async function historicalPriceAvg(
    tariff: Tariff,
    now: Date,
    days: number,
  ): Promise<Map<number, number> | undefined> {
    const from = new Date(now.getTime() - days * 24 * 3600_000)
    const past = await tariff.prices(from, now).catch(() => [] as TariffSlot[])
    if (past.length === 0) return undefined
    const acc = new Map<number, { sum: number; n: number }>()
    for (const s of past) {
      const h = stockholmHour(s.start)
      const cur = acc.get(h) ?? { sum: 0, n: 0 }
      cur.sum += s.pricePerKWh
      cur.n += 1
      acc.set(h, cur)
    }
    return new Map([...acc].map(([h, { sum, n }]) => [h, sum / n]))
  }

  interface ResolvedLoadpoint {
    state: LoadpointState
    shouldChargeNow?: boolean
    budgetA: number
    pricesAvailable: boolean
    sources: { energy: string; price: string; current: string }
  }

  // Resolve a loadpoint's charge decision + current budget through the degradation ladders.
  // Every input comes back as a guaranteed value, so nothing here branches on "is X degraded".
  async function resolveLoadpoint(
    lpCfg: LoadpointConfig,
    now: Date,
  ): Promise<ResolvedLoadpoint | undefined> {
    const state = loadpointStates.get(lpCfg.name)
    if (!state) return undefined
    const sc = config.smartCharging
    const nightWindow = sc.nightWindow

    const targetTime = state.targetTime
      ? parseTargetTime(state.targetTime)
      : new Date(now.getTime() + 24 * 3600_000)
    const hoursUntilTarget = Math.max(0.25, (targetTime.getTime() - now.getTime()) / 3_600_000)

    const balancerCfg = lpCfg.balancer
      ? config.balancers.find((b) => b.name === lpCfg.balancer)
      : undefined
    const chargerCfg = config.chargers.find((c) => c.name === lpCfg.charger) as
      | { phases?: number }
      | undefined
    const phases = balancerCfg?.phases ?? chargerCfg?.phases ?? 3
    // A balancer carries its own circuit fuse; a bare loadpoint falls back to the site fuse.
    const mainBreakerA = balancerCfg?.mainBreakerA ?? config.site.mainBreakerA

    // Energy: cached/estimated SoC → fixed targetKWh → duty-cycle. The SoC estimate is
    // re-anchored to the last real reading (set by maybePollVehicle on connect + during charging).
    let capacity: number | undefined
    const vehicle = lpCfg.vehicle ? vehicles.get(lpCfg.vehicle) : undefined
    if (vehicle) capacity = vehicle.getCachedCapacity()
    const estimatedSocPct = estimatedSocFor(lpCfg.name, capacity, state.sessionEnergyKWh)
    const energy = resolveEnergyTarget({
      estimatedSocPct,
      targetSocPct: state.targetSoc,
      batteryCapacityKWh: capacity,
      targetKWh: state.targetKWh,
      sessionEnergyKWh: state.sessionEnergyKWh,
      hoursUntilTarget,
      maxCurrentA: state.maxCurrentA,
      phases,
    })

    // Price: live tariff → historical average → static night window.
    const tariff = lpCfg.tariff ? tariffs.get(lpCfg.tariff) : undefined
    let livePrices: TariffSlot[] | undefined
    if (tariff && tariff.health() !== 'unavailable') {
      livePrices = await tariff.prices(now, targetTime).catch(() => undefined)
    }
    const historicalAvgByHour =
      (!livePrices || livePrices.length === 0) && tariff
        ? await historicalPriceAvg(tariff, now, sc.historicalDays)
        : undefined
    const price = resolvePriceCurve({
      livePrices,
      historicalAvgByHour,
      now,
      targetTime,
      nightWindow,
    })

    // Current budget: live meter headroom → historical worst-case → time-of-day static.
    const current = resolveCurrentBudget({
      now,
      maxCurrentA: state.maxCurrentA,
      mainBreakerA,
      liveMaxPhaseA: freshMeterMaxPhaseA(now),
      ownDrawA: Math.max(state.currentA, lastCommandedA.get(lpCfg.name) ?? 0),
      worstCaseLoadA:
        mainBreakerA != null
          ? (worstCaseLoadA(db, now, sc.historicalDays) ?? undefined)
          : undefined,
      nightWindow,
      nightMarginA: sc.nightMarginA,
      daytimeFraction: sc.daytimeFraction,
    })

    let shouldChargeNow: boolean | undefined
    if (state.mode === 'smart') {
      shouldChargeNow = decideShouldCharge({
        requiredKWh: energy.value,
        now,
        targetTime,
        planRateA: Math.min(state.maxCurrentA, current.value),
        phases,
        priceSlots: price.value,
      })
    }

    return {
      state,
      shouldChargeNow,
      budgetA: current.value,
      pricesAvailable: !price.degraded,
      sources: { energy: energy.source, price: price.source, current: current.source },
    }
  }

  // Latest balancer output (for the REST balancer view) + per-circuit concurrency guards.
  const lastTickByBalancer = new Map<
    string,
    { allocations: Record<string, number>; freeAmps: number }
  >()
  const tickSlots = new Map<string, { running: boolean; rerun: boolean }>()

  // Tick one circuit: resolve each loadpoint, coordinate the applied amps through the balancer
  // if the circuit has one (else use the resolved budget directly), then command each charger
  // through the deadband. Runs on the control interval and on mode changes.
  async function circuitTick(circuit: Circuit): Promise<void> {
    // Concurrency guard keyed by circuit id: a slow tick marks a rerun instead of overlapping,
    // so the newest state is applied without two ticks racing on the same charger.
    const slot = tickSlots.get(circuit.id) ?? { running: false, rerun: false }
    if (slot.running) {
      slot.rerun = true
      tickSlots.set(circuit.id, slot)
      return
    }
    slot.running = true
    tickSlots.set(circuit.id, slot)

    try {
      const now = new Date()
      const lpCfgs = circuit.kind === 'balancer' ? circuit.loadpoints : [circuit.loadpoint]

      // Lifecycle-owned vehicle polling: refresh on connect + during charging (fire-and-forget;
      // the fresh reading + its anchor are used from the next tick).
      const nowMs = now.getTime()
      for (const lp of lpCfgs) {
        const st = loadpointStates.get(lp.name)
        if (st) maybePollVehicle(lp, st, nowMs)
      }

      const resolved = (await Promise.all(lpCfgs.map((lp) => resolveLoadpoint(lp, now)))).filter(
        (r): r is ResolvedLoadpoint => r !== undefined,
      )
      if (resolved.length === 0) return

      // Surface WHY each loadpoint decided as it did — the key question in a degradation-first
      // system (which rung of each ladder produced the value).
      for (const r of resolved) {
        log.debug(
          {
            loadpoint: r.state.name,
            mode: r.state.mode,
            shouldChargeNow: r.shouldChargeNow,
            budgetA: r.budgetA,
            sources: r.sources,
          },
          'circuit resolve',
        )
      }

      // Balancer circuits coordinate the applied amps across their loadpoints via allocate();
      // bare circuits take the resolved budget directly (planCircuit).
      let allocations: Map<string, number> | null = null
      if (circuit.kind === 'balancer') {
        const balancer = balancers.get(circuit.balancerName)
        if (!balancer) return
        const snaps = resolved.map((r) => {
          const lp = lpCfgs.find((l) => l.name === r.state.name)!
          return buildSnapshot(r.state, lp.vehicle, r.shouldChargeNow, r.pricesAvailable)
        })
        const out = await balancer.tick({ loadpoints: snaps, timestamp: now })
        allocations = out.allocations
        const allocRecord = Object.fromEntries(out.allocations)
        const freeAmps = out.freeAmps ?? 0
        lastTickByBalancer.set(circuit.balancerName, { allocations: allocRecord, freeAmps })
        events.emit('balancer.tick', {
          name: circuit.balancerName,
          allocations: allocRecord,
          freeAmps,
          health: balancer.health(),
        })
        updateHealth(health, circuit.balancerName, balancer.health())
      }

      const decisions: LpDecision[] = resolved.map((r) => ({
        loadpointName: r.state.name,
        mode: r.state.mode,
        shouldChargeNow: r.shouldChargeNow,
        budgetA: r.budgetA,
        lastCommandedA: lastCommandedA.get(r.state.name),
      }))
      const { writes } = planCircuit(decisions, allocations, config.smartCharging.deadbandA)
      for (const [lpId, amps] of writes) {
        const charger = chargerLimitMap.get(lpId)
        if (charger) {
          await charger.setCurrentLimit(amps).catch(() => {})
          lastCommandedA.set(lpId, amps) // record only actual writes → allocator credit-back stays honest
        }
      }
    } finally {
      slot.running = false
      if (slot.rerun) {
        slot.rerun = false
        void circuitTick(circuit)
      }
    }
  }

  async function runAllCircuits(): Promise<void> {
    await Promise.all(circuits.map((c) => circuitTick(c)))
  }

  // HTTP server (REST + SSE)
  // chargerLimitMap is keyed by loadpoint name so REST routes can look up by loadpoint
  const chargerLimitMap = new Map<string, Charger>()
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
    config,
    tariffs,
    meterReaders,
    balancers,
    vehicles,
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
    startMqttBridge(
      config.mqtt,
      {
        events,
        loadpoints: loadpointStates,
        tariffs,
        balancers,
        vehicles,
        health,
        onModeChange: handleModeChange,
        onTargetChange: handleTargetChange,
      },
      log,
    )
    log.info({ host: config.mqtt.host }, 'MQTT bridge starting')
  }

  // Single control loop: one damped tick drives every circuit (balancer-backed or bare), so
  // smart mode works with or without a balancer. Interval is kept slow (default 30 s) because a
  // charger/car takes 15–30 s to act on a new limit — ticking faster just makes it oscillate.
  void runAllCircuits() // immediate first tick
  const controlInterval = setInterval(
    () => void runAllCircuits(),
    config.smartCharging.controlIntervalSec * 1000,
  )
  log.info(
    { intervalSec: config.smartCharging.controlIntervalSec, circuits: circuits.length },
    'control loop started',
  )

  log.info('OpenSmartCharge ready')

  const shutdown = () => {
    log.info('shutting down gracefully')
    clearInterval(controlInterval)
    httpServer.close()
    if (ocppServer) void ocppServer.close()
    for (const b of balancers.values()) void b.stop()
    for (const v of vehicles.values()) void v.stop()
    for (const t of tariffs.values()) void t.stop()
    for (const r of meterReaders.values()) void r.stop()
    db.close()
    process.exit(0)
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

// Parse "HH:MM" into the next occurrence of that time in Stockholm-local wall-clock (today or
// tomorrow) — matching how Nord Pool prices and the night window are reasoned about. Previously
// used server-local setHours, which was only correct when the host TZ happened to be Stockholm.
function parseTargetTime(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  const now = new Date()
  return new Date(now.getTime() + msUntilStockholmTime(now, h, m))
}

main().catch((err) => {
  console.error('fatal startup error', err)
  process.exit(1)
})
