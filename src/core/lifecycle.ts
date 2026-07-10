// First-party module imports — explicit so the dependency graph is clear
import '../modules/charger-ocpp16/index.js'
import '../modules/tariff-elering/index.js'
import '../modules/tariff-elprisetjustnu/index.js'
import '../modules/tariff-fixed/index.js'
import '../modules/meter-tibber-pulse/index.js'
import '../modules/meter-mqtt-phase/index.js'
import '../modules/balancer-mqtt-circuit/index.js'
import '../modules/vehicle-skoda/index.js'

import { loadConfig, CONFIG_PATH, DATA_DIR } from './config.js'
import { openDb } from './db.js'
import { createLogger } from './logger.js'
import { createLogCaptureStream, patchConsole, pruneLogs } from './log-store.js'
import { loadPlugins } from './plugin-loader.js'
import {
  loadLoadpointStates,
  configToLoadpointInits,
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
import { localDateKey, localHour, msUntilLocalTime } from '../sdk/local-time.js'
import { getTimezone, seedSettings, getLogRetentionDays } from './settings.js'
import { getEffectiveConfig } from './config-overrides.js'
import { createReconciler } from './reconcile.js'
import { listPlans, selectActivePlan, planTargetTime } from './plans.js'
import type { Balancer, LoadpointSnapshot } from '../sdk/balancer.js'
import type { Vehicle } from '../sdk/vehicle.js'
import type { LoadpointState } from './loadpoint.js'
import type { ChargeMode, LoadpointConfig } from './config.js'
import { estimateSocSinceAnchor, observedEfficiency } from './estimator.js'
import { resolveTarget, type Target } from './smart-charging/energy.js'
import { resolvePriceCurve } from './smart-charging/price.js'
import { resolveCurrentBudget } from './smart-charging/current.js'
import { decideShouldCharge, forceMinSoc, forceClimate } from './smart-charging/decide.js'
import { shouldPollVehicle } from './smart-charging/vehicle-poll.js'
import {
  buildCircuits,
  circuitForLoadpoint,
  circuitLiveMaxPhaseA,
  circuitOwnDrawA,
  planCircuit,
  shouldExpireFastToSmart,
  softStartLimit,
  FAST_BOOST_UNPLUG_GRACE_MS,
  type Circuit,
  type LpDecision,
} from './control-loop.js'
import {
  decideSession,
  executeSessionAction,
  SESSION_RECONCILE,
  type SessionReconcilerState,
} from './session-reconciler.js'
import { backoffDelayMs } from './source-reconciler.js'
import type { ModuleHealth } from '../sdk/types.js'

const PLUGINS_DIR = process.env.OSC_PLUGINS_DIR ?? './plugins'

async function main() {
  // Open the DB first so the logger's capture leg (core/log-store.ts) can persist from the very first
  // line, then tee console.* — both before loadPlugins, so non-conforming plugins/deps are captured too.
  const db = openDb(DATA_DIR)
  const log = createLogger([createLogCaptureStream(db)])
  patchConsole(db)
  log.info('OpenSmartCharge starting')
  log.info({ dataDir: DATA_DIR }, 'database ready')

  // Effective config = parsed osc.yaml (seed) + runtime DB overrides (persist-wins). The lifecycle
  // runs on this object; the reconcile seam keeps it in sync IN PLACE on API-driven config changes.
  const baseConfig = loadConfig(CONFIG_PATH)
  const config = getEffectiveConfig(baseConfig, db)
  log.info({ site: config.site.name, port: config.site.port }, 'config loaded')

  // Seed system settings (e.g. site timezone) from config into the DB on first boot; runtime
  // values (UI setup auto-detect) win thereafter. Re-assert declaratively via `npm run config:apply`.
  seedSettings(db, config)
  log.info({ timezone: getTimezone(db) }, 'settings ready')

  const events = createEventBus()
  const health = createHealthMap()

  // Health → SSE. setHealth updates the map AND emits `health.changed` when a module's health value
  // actually changes, so the UI status view is live (not poll-only, which left it stale). Tracked
  // against a separate last-emitted snapshot so an emit fires regardless of which path last wrote the
  // map. A periodic sweepHealth() (below) re-evaluates every module so staleness-driven transitions
  // (a tariff going stale at the publish window, a vehicle after failed polls) surface on their own.
  const lastEmittedHealth = new Map<string, ModuleHealth>()
  const setHealth = (id: string, h: ModuleHealth): void => {
    updateHealth(health, id, h)
    if (lastEmittedHealth.get(id) !== h) {
      lastEmittedHealth.set(id, h)
      events.emit('health.changed', { id, health: h })
    }
  }

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
      const tz = getTimezone(db)
      recordHouseholdLoad(db, s.timestamp, maxPhaseA, tz)
      const dayKey = localDateKey(s.timestamp, tz)
      if (dayKey !== lastRollupPruneDay) {
        lastRollupPruneDay = dayKey
        // Keep a few days beyond the look-back window so the query range is always covered.
        pruneHouseholdLoad(db, s.timestamp, config.smartCharging.historicalDays + 4, tz)
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
    const deprecated = (
      ['safeStaticCurrentA', 'meterStaleAfterSec', 'meterTopicPrefix', 'intervalSec'] as const
    ).filter((k) => (balancerCfg as Record<string, unknown>)[k] !== undefined)
    if (deprecated.length)
      log.warn(
        { balancer: balancerCfg.name, deprecated },
        'balancer fields are deprecated + ignored — the meter + its staleness moved to a MeterReader; use `meterReader` for live data and `nightMarginA`/`daytimeFraction` for the static fallback',
      )
    const balancer = mod.create(balancerCfg, ctx)
    await balancer.start()
    balancers.set(balancerCfg.name, balancer)
    updateHealth(health, balancerCfg.name, balancer.health())
    log.info({ balancer: balancerCfg.name, type: balancerCfg.type }, 'balancer module created')
  }

  // maxA per loadpoint comes from the referenced charger config (see configToLoadpointInits).
  const loadpointStates = loadLoadpointStates(db, configToLoadpointInits(config))
  log.info({ loadpoints: [...loadpointStates.keys()] }, 'loadpoints initialized')

  // Group loadpoints into circuits (balancer-shared vs bare). The single control loop ticks every
  // circuit. Rebuildable IN PLACE so reconcile (add/remove loadpoint) can regroup without replacing
  // the array reference the control loop closes over.
  const circuits: Circuit[] = []
  const rebuildCircuits = () => {
    circuits.length = 0
    circuits.push(...buildCircuits(config))
  }
  rebuildCircuits()

  // When the OCPP connector first went `Available` (car unplugged), per loadpoint. Fast is a one-shot
  // "boost until unplugged": circuitTick reverts fast→smart once this exceeds the grace. Keyed off
  // `Available` (a real unplug) — NOT the raw WS link — so a wifi/WS blip (which reports `Unavailable`)
  // or an OSC restart (no Available seen) keeps Fast, and only a genuine end-of-session reverts it.
  const availableSince = new Map<string, number>()

  // Wire a charger's status → loadpoint state → event bus. Extracted into a helper AND the returned
  // unsubscribe is KEPT (by loadpoint name), so reconcile can re-wire or drop a charger without
  // leaking or double-firing listeners. Calling it again for the same loadpoint drops the prior sub.
  const chargerUnsubs = new Map<string, () => void>()
  function wireChargerStatus(
    lpCfg: LoadpointConfig,
    charger: Charger,
    state: LoadpointState,
  ): void {
    chargerUnsubs.get(lpCfg.name)?.()
    const unsub = charger.onStatus((status) => {
      Object.assign(state, foldChargerStatus(state, status))
      // Track the unplugged-since time for the Fast-boost expiry (set on the first Available frame,
      // cleared as soon as the connector leaves Available — i.e. the car is plugged again).
      if (status.status === 'Available') {
        if (!availableSince.has(lpCfg.name)) availableSince.set(lpCfg.name, Date.now())
      } else {
        availableSince.delete(lpCfg.name)
      }
      // Charger module health tracks connection state — refresh (+ emit health.changed) on
      // connect/disconnect so the UI reflects a drop/reconnect live, not up to a sweep interval later.
      setHealth(lpCfg.charger, charger.health())
      // Persist energy for estimation when vehicle is offline
      events.emit('loadpoint.state', {
        name: state.name,
        connected: state.connected,
        charging: state.charging,
        currentA: state.currentA,
        powerW: state.powerW,
        sessionEnergyKWh: state.sessionEnergyKWh,
      })
    })
    chargerUnsubs.set(lpCfg.name, unsub)
  }

  for (const lpCfg of config.loadpoints) {
    const charger = chargers.get(lpCfg.charger)
    if (!charger) continue
    wireChargerStatus(lpCfg, charger, loadpointStates.get(lpCfg.name)!)
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
    minSoc?: number,
  ): Promise<void> {
    const state = loadpointStates.get(name)
    if (!state) return
    // Merge: undefined = "leave unchanged", so a partial update (e.g. just soc) doesn't wipe the
    // other targets. Mirrors setLoadpointTarget's COALESCE in the DB.
    if (soc !== undefined) state.targetSoc = soc
    if (time !== undefined) state.targetTime = time
    if (kwh !== undefined) state.targetKWh = kwh
    if (minSoc !== undefined) state.minSoc = minSoc
    setLoadpointTarget(db, name, soc, time, kwh, minSoc)
    events.emit('loadpoint.target', {
      name,
      targetSoc: state.targetSoc,
      targetTime: state.targetTime,
      targetKWh: state.targetKWh,
      minSoc: state.minSoc,
    })
    // A new target changes the plan — tick the circuit now instead of waiting for the interval.
    const circuit = circuitForLoadpoint(circuits, name)
    if (circuit) void circuitTick(circuit)
  }

  // Plans changed via the API → emit for SSE + re-tick so the new/removed plan takes effect now.
  function handlePlansChanged(name: string): void {
    events.emit('loadpoint.plans', { name })
    const circuit = circuitForLoadpoint(circuits, name)
    if (circuit) void circuitTick(circuit)
  }

  // Last amps value successfully sent to each charger. Keyed by loadpoint name (= LoadpointSnapshot.id).
  // Used to give the allocator an accurate credit-back during the car's ramp-up period.
  const lastCommandedA = new Map<string, number>()

  // SessionReconciler guard-state per loadpoint. The reconciler is level-triggered: each tick it
  // reconciles "OSC wants charge" against the observed connector status + draw + the car's own
  // telemetry, taking one guarded corrective action (RemoteStart / resume / car-side wake / clear
  // profile / reset) when they diverge. Supersedes the old transaction-gated resume-nudge, which
  // could only resume an already-open transaction (never open one, never wake the car).
  const sessionStates = new Map<string, SessionReconcilerState>()
  // When charging is driven ONLY by climate (preconditioning, battery already at target), offer just
  // the IEC minimum rather than the full circuit budget — the car draws only its climate load, and
  // this avoids topping the battery past the target at full rate. The car chooses how much it pulls.
  const CLIMATE_MAX_OFFER_A = 6

  // Last-emitted resolve per loadpoint (as JSON) — change-guard so `loadpoint.resolve` only fires
  // when the decision actually changes, not every ~30 s tick with an identical frame.
  const lastResolveByLoadpoint = new Map<string, string>()

  // On a FAILED warranted poll, retry with capped exponential backoff (seconds→minutes) instead of
  // waiting the full 15 min idle cadence — so a transient car-API outage recovers fast when it
  // clears, without hammering the rate-limited API. base ≈ one control tick.
  const VEHICLE_POLL_BACKOFF = { baseMs: 30_000, factor: 2, maxMs: 300_000 }

  // Lifecycle-owned vehicle polling (the module owns no timer). Per loadpoint: when we last polled
  // + whether we've polled since this connection began + a consecutive-failure count for backoff;
  // and the SoC "anchor" — a real reading + the session energy at that moment — so the estimate
  // carries it forward by kWh delivered SINCE, instead of double-counting the whole session.
  const vehiclePollState = new Map<
    string,
    { lastPollAt: number; polledThisConnection: boolean; consecutiveFailures: number }
  >()
  const vehicleAnchor = new Map<string, { soc: number; sessionEnergyKWh: number }>()
  // The session's FIRST real reading, kept alongside the latest anchor so we can observe THIS
  // session's charging efficiency (see effectiveEfficiencyFor). Reset on disconnect, so each
  // charging session measures its own efficiency; never persisted across sessions.
  const sessionFirstReading = new Map<string, { soc: number; sessionEnergyKWh: number }>()
  // Loadpoints we've already warned about being below minSoc while disabled (warn once per episode).
  const minSocWarned = new Set<string>()

  // Charging efficiency to use for this loadpoint right now: the value OBSERVED this session (two
  // real readings with enough delta) when available, else the configured default. Session-scoped.
  function effectiveEfficiencyFor(
    lpName: string,
    capacity: number | undefined,
  ): { efficiency: number; observed: number | undefined } {
    const first = sessionFirstReading.get(lpName)
    const latest = vehicleAnchor.get(lpName)
    const observed =
      first && latest
        ? observedEfficiency(
            { soc: first.soc, sessionKWh: first.sessionEnergyKWh },
            { soc: latest.soc, sessionKWh: latest.sessionEnergyKWh },
            capacity,
          )
        : undefined
    return { efficiency: observed ?? config.smartCharging.chargingEfficiency, observed }
  }

  // Re-anchored SoC estimate: last real SoC + (session kWh since) × efficiency / capacity, using the
  // observed-this-session efficiency when we have it — so a car-API dropout stays accurate.
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
      effectiveEfficiencyFor(lpName, capacity).efficiency,
    )
  }

  // Assemble the energy context for a loadpoint from whatever data sources it has — the vehicle
  // today; a charger reading SoC over the Type-2 wire could feed the same shape later. The resolver
  // takes plain data (not a Vehicle), so it stays source-agnostic. getData() is cached (no network).
  async function gatherEnergyContext(
    lpCfg: LoadpointConfig,
    state: LoadpointState,
  ): Promise<{
    estimatedSocPct?: number
    soc?: number
    range?: number
    capacity?: number
    climateActive?: boolean
    sessionEnergyKWh: number
    efficiency: number
  }> {
    const vehicle = lpCfg.vehicle ? vehicles.get(lpCfg.vehicle) : undefined
    const capacity = vehicle?.getCachedCapacity()
    let soc: number | undefined
    let range: number | undefined
    let climateActive: boolean | undefined
    if (vehicle) {
      const data = await vehicle.getData().catch(() => undefined)
      soc = data?.soc
      range = data?.range
      climateActive = data?.climateActive
    }
    const eff = effectiveEfficiencyFor(lpCfg.name, capacity)
    // Surface the observed-this-session efficiency when we have one, so it's visible in the logs
    // overnight (fallback is the configured constant, not logged as it's the uninteresting case).
    if (eff.observed !== undefined)
      log.debug(
        {
          loadpoint: lpCfg.name,
          observedEfficiency: Number(eff.observed.toFixed(3)),
          fallback: config.smartCharging.chargingEfficiency,
        },
        'using observed session charging efficiency',
      )
    return {
      estimatedSocPct: estimatedSocFor(lpCfg.name, capacity, state.sessionEnergyKWh),
      soc,
      range,
      capacity,
      climateActive,
      sessionEnergyKWh: state.sessionEnergyKWh,
      efficiency: eff.efficiency,
    }
  }

  // Poll gate: refresh a loadpoint's vehicle on (re)connect, then on two cadences while plugged in —
  // vehiclePollIntervalSec while actively drawing (re-anchor the estimate), the faster
  // vehicleIdlePollIntervalSec while connected-but-idle (catch climate/plug changes). Never while
  // unplugged. Fire-and-forget — the fresh reading + its anchor are used from the next tick.
  function maybePollVehicle(lpCfg: LoadpointConfig, state: LoadpointState, nowMs: number): void {
    if (!lpCfg.vehicle) return
    const vehicle = vehicles.get(lpCfg.vehicle)
    if (!vehicle) return
    const vp = vehiclePollState.get(lpCfg.name) ?? {
      lastPollAt: 0,
      polledThisConnection: false,
      consecutiveFailures: 0,
    }
    if (!state.connected) {
      vp.polledThisConnection = false // reset so the next connection re-anchors on its first tick
      vp.consecutiveFailures = 0 // fresh connection → drop any stale backoff
      vehiclePollState.set(lpCfg.name, vp)
      sessionFirstReading.delete(lpCfg.name) // each new charging session measures its own efficiency
      return
    }
    // Idle polling is faster during the day window (when preconditioning/departure happens) and
    // falls back to the slow charging cadence at night, so an overnight-plugged car isn't hammered.
    const sc = config.smartCharging
    const h = localHour(new Date(nowMs), getTimezone(db))
    const { startHour: ds, endHour: de } = sc.vehicleIdlePollDayWindow
    const isDay = ds <= de ? h >= ds && h < de : h >= ds || h < de
    // While a poll is failing, override the normal cadence with a short backoff so recovery is
    // prompt instead of one-per-15-min; otherwise use the drawing/idle cadence as usual.
    const backoffMs = backoffDelayMs(vp.consecutiveFailures, VEHICLE_POLL_BACKOFF)
    const chargingIntervalMs = backoffMs > 0 ? backoffMs : sc.vehiclePollIntervalSec * 1000
    const idleIntervalMs =
      backoffMs > 0
        ? backoffMs
        : (isDay ? sc.vehicleIdlePollIntervalSec : sc.vehiclePollIntervalSec) * 1000
    const should = shouldPollVehicle({
      now: nowMs,
      connected: state.connected,
      drawing: state.currentA > 0,
      lastPollAt: vp.lastPollAt,
      chargingIntervalMs,
      idleIntervalMs,
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
        vp.consecutiveFailures = 0 // success → clear backoff, back to the normal cadence
        const reading = { soc: data.soc, sessionEnergyKWh: state.sessionEnergyKWh }
        vehicleAnchor.set(lpCfg.name, reading)
        // Record the session's first real reading once; with a later one it yields observed efficiency.
        if (!sessionFirstReading.has(lpCfg.name)) sessionFirstReading.set(lpCfg.name, reading)
        setHealth(vehicleName, vehicle.health())
      })
      .catch((err) => {
        // Count the failure so the next poll retries on the short backoff, and reflect the now-
        // failure-aware module health immediately (don't wait for the periodic sweep).
        vp.consecutiveFailures++
        setHealth(vehicleName, vehicle.health())
        log.warn(
          { err, vehicle: vehicleName, consecutiveFailures: vp.consecutiveFailures },
          'vehicle refresh failed',
        )
      })
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
      targetTime: state.targetTime ? parseTargetTime(state.targetTime, getTimezone(db)) : undefined,
      maxCurrentA: state.maxCurrentA,
      pricesAvailable,
      shouldChargeNow,
    }
  }

  // Average price per Stockholm hour-of-day over the last N days (price fallback rung). Reuses
  // the tariff's own cache via prices() — no zone plumbing needed. Only computed when live
  // prices are missing.
  async function historicalPriceAvg(
    tariff: Tariff,
    now: Date,
    days: number,
    tz: string,
  ): Promise<Map<number, number> | undefined> {
    const from = new Date(now.getTime() - days * 24 * 3600_000)
    const past = await tariff.prices(from, now).catch(() => [] as TariffSlot[])
    if (past.length === 0) return undefined
    const acc = new Map<number, { sum: number; n: number }>()
    for (const s of past) {
      const h = localHour(s.start, tz)
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
    /** Charging is driven ONLY by climate-force (target reached, price wouldn't charge) — so this is
     * just preconditioning: offer the IEC minimum, not the full budget. */
    climateOnly: boolean
    pricesAvailable: boolean
    sources: { energy: string; price: string; current: string }
  }

  // Resolve a loadpoint's charge decision + current budget through the degradation ladders.
  // Every input comes back as a guaranteed value, so nothing here branches on "is X degraded".
  async function resolveLoadpoint(
    lpCfg: LoadpointConfig,
    now: Date,
    circuitBudget: { value: number; source: string },
  ): Promise<ResolvedLoadpoint | undefined> {
    const state = loadpointStates.get(lpCfg.name)
    if (!state) return undefined
    const sc = config.smartCharging
    const nightWindow = sc.nightWindow
    const tz = getTimezone(db) // site timezone — all wall-clock planning this tick uses it

    // A recurring plan that governs NOW takes precedence over the ad-hoc loadpoint target; with no
    // active plan we fall back to state.target* (guest / manual one-off). Plans are read live each
    // tick — no reload (see core/plans.ts for the resolution rule).
    const activePlan = selectActivePlan(listPlans(db, lpCfg.name), now, tz)
    if (activePlan)
      log.debug(
        { loadpoint: lpCfg.name, plan: activePlan.id, readyBy: activePlan.readyBy },
        'active plan governs',
      )

    const targetTime = activePlan
      ? planTargetTime(activePlan, now, tz)
      : state.targetTime
        ? parseTargetTime(state.targetTime, tz)
        : new Date(now.getTime() + 24 * 3600_000)
    const hoursUntilTarget = Math.max(0.25, (targetTime.getTime() - now.getTime()) / 3_600_000)

    const balancerCfg = lpCfg.balancer
      ? config.balancers.find((b) => b.name === lpCfg.balancer)
      : undefined
    const chargerCfg = config.chargers.find((c) => c.name === lpCfg.charger) as
      | { phases?: number }
      | undefined
    const phases = balancerCfg?.phases ?? chargerCfg?.phases ?? 3

    // One target → one resolved { requiredKWh (charge) + resolvedSoc (display) } through the single
    // resolver, which owns unit conversion (km→% via the car's ratio) and the degradation ladder.
    // The target is the governing plan or the ad-hoc loadpoint target, preferring % when capacity
    // lets us size it (else the kWh-to-add fallback) — mirroring the ladder's own rung order.
    const ectx = await gatherEnergyContext(lpCfg, state)
    const estimatedSocPct = ectx.estimatedSocPct
    let target: Target | null = null
    if (activePlan) target = { unit: activePlan.unit, value: activePlan.target }
    else if (state.targetSoc != null && (ectx.capacity != null || state.targetKWh == null))
      target = { unit: 'pct', value: state.targetSoc }
    else if (state.targetKWh != null) target = { unit: 'kwh', value: state.targetKWh }
    const energy = resolveTarget(target, {
      ...ectx,
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
        ? await historicalPriceAvg(tariff, now, sc.historicalDays, tz)
        : undefined
    const price = resolvePriceCurve({
      livePrices,
      historicalAvgByHour,
      now,
      targetTime,
      nightWindow,
      tz,
    })

    // minSoc safety floor: in smart mode, force-charge when the SoC is below the minimum (bypasses
    // the price wait). In disabled mode we respect the explicit Off but warn once per episode.
    // Unknown SoC / no minSoc → no floor (never force-charge blind).
    const belowMinSoc = forceMinSoc(estimatedSocPct, state.minSoc)
    let shouldChargeNow: boolean | undefined
    let climateOnly = false
    if (state.mode === 'smart') {
      const priceDecision = decideShouldCharge({
        requiredKWh: energy.requiredKWh,
        now,
        targetTime,
        planRateA: Math.min(state.maxCurrentA, circuitBudget.value),
        phases,
        priceSlots: price.value,
      })
      // Preconditioning: if the car is climatising while plugged in, force-charge to feed that load
      // from the grid rather than the battery — overrides both the price wait and a reached target.
      const climateForce = forceClimate(ectx.climateActive, state.connected)
      shouldChargeNow = belowMinSoc || climateForce || priceDecision
      // Climate is the SOLE reason to charge (battery at target, price wouldn't charge) → this is
      // pure preconditioning, so we offer only the IEC minimum (6 A), not the full circuit budget.
      climateOnly = climateForce && !priceDecision && !belowMinSoc
      if (belowMinSoc && !priceDecision)
        log.debug(
          { loadpoint: lpCfg.name, estimatedSoc: estimatedSocPct, minSoc: state.minSoc },
          'minSoc floor: force-charging past the price wait',
        )
      if (climateForce && !priceDecision)
        log.debug(
          { loadpoint: lpCfg.name },
          'climate active: force-charging to supply preconditioning from the grid',
        )
    }
    if (belowMinSoc && state.mode === 'disabled') {
      if (!minSocWarned.has(lpCfg.name)) {
        minSocWarned.add(lpCfg.name)
        log.warn(
          { loadpoint: lpCfg.name, estimatedSoc: estimatedSocPct, minSoc: state.minSoc },
          'SoC below minSoc but loadpoint is disabled — not charging',
        )
      }
    } else {
      minSocWarned.delete(lpCfg.name)
    }

    return {
      state,
      shouldChargeNow,
      climateOnly,
      pricesAvailable: !price.degraded,
      sources: { energy: energy.source, price: price.source, current: circuitBudget.source },
    }
  }

  // Latest balancer output (for the REST balancer view) + per-circuit concurrency guards.
  const lastTickByBalancer = new Map<
    string,
    { allocations: Record<string, number>; freeAmps: number }
  >()
  const tickSlots = new Map<string, { running: boolean; rerun: boolean }>()
  // Throttle for the "phase over the fuse" diagnostic (observe-don't-twitch): at most one warn per
  // circuit per 5 min, so a persistent overshoot doesn't spam while we deliberately DON'T react faster.
  const lastBreakerWarnMs = new Map<string, number>()

  // One current budget per CIRCUIT (bare = its single loadpoint; balancer = all of its loadpoints),
  // resolved through the single ladder (live-meter headroom → historical worst-case → static
  // time-of-day). This is the ONLY place the meter is read: the balancer splits the result and a
  // bare loadpoint takes it directly. Per-breaker margins fall back to the global smartCharging.*.
  function resolveCircuitBudget(circuit: Circuit, now: Date): { value: number; source: string } {
    const sc = config.smartCharging
    const tz = getTimezone(db)
    const worst = (breaker: number | undefined) =>
      breaker != null ? (worstCaseLoadA(db, now, sc.historicalDays, tz) ?? undefined) : undefined
    // Observe, don't twitch: a phase above the fuse is a diagnostic signal (a real load event, or our
    // calc drifting) — surfaced for analysis, throttled, and NOT reacted to faster than the 30 s loop,
    // which corrects it on the next tick. Reacting per meter frame would over-steer the charger.
    const flagExceedance = (
      id: string,
      breaker: number | undefined,
      liveMax: number | undefined,
    ) => {
      if (breaker == null || liveMax == null || liveMax <= breaker) return
      const nowMs = now.getTime()
      if (nowMs - (lastBreakerWarnMs.get(id) ?? 0) < 300_000) return
      lastBreakerWarnMs.set(id, nowMs)
      log.warn(
        {
          circuit: id,
          maxPhaseA: Number(liveMax.toFixed(1)),
          mainBreakerA: breaker,
          overByA: Number((liveMax - breaker).toFixed(1)),
        },
        'phase current above the main fuse — a brief overshoot the next tick corrects (observed, not steered faster)',
      )
    }
    if (circuit.kind === 'balancer') {
      const b = config.balancers.find((x) => x.name === circuit.balancerName)
      const mainBreakerA = b?.mainBreakerA
      const liveMaxPhaseA = circuitLiveMaxPhaseA(b?.meterReader, meterReaders)
      flagExceedance(circuit.id, mainBreakerA, liveMaxPhaseA)
      const r = resolveCurrentBudget({
        now,
        // The splittable budget is the circuit fuse; per-charger maxA is enforced in allocate().
        maxCurrentA: mainBreakerA ?? 0,
        mainBreakerA,
        liveMaxPhaseA,
        ownDrawA: circuitOwnDrawA(circuit.loadpoints, loadpointStates, lastCommandedA),
        worstCaseLoadA: worst(mainBreakerA),
        reserveA: b?.reserveA ?? sc.reserveA,
        nightWindow: sc.nightWindow,
        nightMarginA: b?.nightMarginA ?? sc.nightMarginA,
        daytimeFraction: b?.daytimeFraction ?? sc.daytimeFraction,
        tz,
      })
      return { value: r.value, source: r.source }
    }
    const state = loadpointStates.get(circuit.loadpoint.name)
    const mainBreakerA = config.site.mainBreakerA
    const liveMaxPhaseA = circuitLiveMaxPhaseA(undefined, meterReaders)
    flagExceedance(circuit.id, mainBreakerA, liveMaxPhaseA)
    const r = resolveCurrentBudget({
      now,
      maxCurrentA: state?.maxCurrentA ?? 0,
      mainBreakerA,
      liveMaxPhaseA,
      ownDrawA: Math.max(state?.currentA ?? 0, lastCommandedA.get(circuit.loadpoint.name) ?? 0),
      worstCaseLoadA: worst(mainBreakerA),
      reserveA: sc.reserveA,
      nightWindow: sc.nightWindow,
      nightMarginA: sc.nightMarginA,
      daytimeFraction: sc.daytimeFraction,
      tz,
    })
    return { value: r.value, source: r.source }
  }

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

      // Lifecycle-owned vehicle polling + Fast-boost expiry.
      const nowMs = now.getTime()
      for (const lp of lpCfgs) {
        const st = loadpointStates.get(lp.name)
        if (!st) continue
        // Fast is a boost until the car is unplugged: once the connector has been Available past the
        // grace, revert to smart (persist + emit). Brief unplugs / WS blips / restarts keep Fast.
        if (
          shouldExpireFastToSmart(
            st.mode,
            availableSince.get(lp.name),
            nowMs,
            FAST_BOOST_UNPLUG_GRACE_MS,
          )
        ) {
          st.mode = 'smart'
          setLoadpointMode(db, lp.name, 'smart')
          availableSince.delete(lp.name)
          events.emit('loadpoint.mode', { name: lp.name, mode: 'smart' })
          log.info(
            { loadpoint: lp.name },
            'fast boost expired (car unplugged past grace) — reverting to smart',
          )
        }
        maybePollVehicle(lp, st, nowMs)
      }

      // One budget for the whole circuit (the only meter read this tick); each loadpoint resolves
      // its charge decision against it.
      const circuitBudget = resolveCircuitBudget(circuit, now)
      const resolved = (
        await Promise.all(lpCfgs.map((lp) => resolveLoadpoint(lp, now, circuitBudget)))
      ).filter((r): r is ResolvedLoadpoint => r !== undefined)
      if (resolved.length === 0) return

      // Surface WHY each loadpoint decided as it did — the key question in a degradation-first
      // system (which rung of each ladder produced the value).
      for (const r of resolved) {
        // Surface the decision on the loadpoint state (the "why", readable via GET /api/loadpoints).
        r.state.resolve = {
          shouldChargeNow: r.shouldChargeNow,
          budgetA: circuitBudget.value,
          sources: r.sources,
        }
        log.debug(
          {
            loadpoint: r.state.name,
            mode: r.state.mode,
            shouldChargeNow: r.shouldChargeNow,
            budgetA: circuitBudget.value,
            sources: r.sources,
          },
          'circuit resolve',
        )
        // Push to SSE only when the decision changes — identical across most ticks, so a change-guard
        // avoids an idle frame every interval.
        const key = JSON.stringify(r.state.resolve)
        if (lastResolveByLoadpoint.get(r.state.name) !== key) {
          lastResolveByLoadpoint.set(r.state.name, key)
          events.emit('loadpoint.resolve', { name: r.state.name, ...r.state.resolve })
        }
      }

      // Balancer circuits coordinate the applied amps across their loadpoints via allocate();
      // bare circuits take the resolved budget directly (planCircuit).
      let allocations: Map<string, number> | null = null
      if (circuit.kind === 'balancer') {
        const balancer = balancers.get(circuit.balancerName)
        if (!balancer) return
        const snaps = resolved.map((r) => {
          const lp = lpCfgs.find((l) => l.name === r.state.name)!
          const snap = buildSnapshot(r.state, lp.vehicle, r.shouldChargeNow, r.pricesAvailable)
          // Climate-only → cap this loadpoint's allocatable current at the IEC minimum.
          if (r.climateOnly) snap.maxCurrentA = Math.min(snap.maxCurrentA, CLIMATE_MAX_OFFER_A)
          return snap
        })
        const out = await balancer.tick({
          loadpoints: snaps,
          circuitBudgetA: circuitBudget.value,
          timestamp: now,
        })
        allocations = out.allocations
        const allocRecord = Object.fromEntries(out.allocations)
        const freeAmps = circuitBudget.value // the resolved circuit headroom (what freeAmps meant before)
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
        // Climate-only → cap the bare-circuit offer at the IEC minimum (not the full budget).
        budgetA: r.climateOnly
          ? Math.min(CLIMATE_MAX_OFFER_A, circuitBudget.value)
          : circuitBudget.value,
        lastCommandedA: lastCommandedA.get(r.state.name),
      }))
      const { amps, writes } = planCircuit(decisions, allocations, config.smartCharging.deadbandA)
      for (const [lpId, w] of writes) {
        const charger = chargerLimitMap.get(lpId)
        if (charger) {
          // Soft-start a resume: if we were paused (~0 A), command half the target this tick so the
          // car ramps gently instead of briefly overshooting the fuse; the next tick reaches full.
          const limit = softStartLimit(w, lastCommandedA.get(lpId) ?? 0)
          await charger.setCurrentLimit(limit).catch(() => {})
          lastCommandedA.set(lpId, limit) // record the ACTUAL command → credit-back + next-tick ramp stay honest
        }
      }

      // SessionReconciler: level-triggered recovery. For each loadpoint, reconcile "OSC wants charge"
      // (commanded amps > 0) against the observed connector status + live draw + the car's own
      // telemetry, and take at most ONE guarded corrective action this tick — RemoteStart to open a
      // session, RemoteStop+RemoteStart to un-latch a SuspendedEV, a car-side wake for a car-side
      // pause (chargeMode OFF, which no charger command overrides), a profile clear, or a Hard reset.
      // Grace/cooldown/cap live inside decideSession. This runs on the 30 s control cadence ONLY
      // (never faster), so recovery actions can't churn the charger.
      const sessionNowMs = now.getTime()
      for (const r of resolved) {
        const lpId = r.state.name
        const charger = chargerLimitMap.get(lpId)
        if (!charger) continue
        const lp = lpCfgs.find((l) => l.name === lpId)
        const vehicle = lp?.vehicle ? vehicles.get(lp.vehicle) : undefined
        // Cached read (no network) — the car's own plug/charging view as an independent cross-check.
        const carData = vehicle ? await vehicle.getData().catch(() => undefined) : undefined
        const commandedA = amps.get(lpId) ?? 0
        // The car's own care ceiling: at/above it the car won't accept more current (fast mode
        // commands current regardless of target, so without this the reconciler would try to
        // "recover" a full car). Uses the car's OWN targetSoc — the real physical limit.
        const carAtTarget =
          carData?.soc != null && carData.targetSoc != null && carData.soc >= carData.targetSoc
        const dec = decideSession(
          sessionStates.get(lpId) ?? { phaseAttempts: 0, totalActions: 0 },
          {
            wantsCharge: commandedA > 0,
            status: r.state.status,
            drawingA: r.state.currentA,
            carPluggedIn: carData?.pluggedIn,
            carCharging: carData?.isCharging,
            carAtTarget,
            vehicleCanActuate: typeof vehicle?.startCharging === 'function',
            chargerCanRemoteStart: typeof charger.remoteStart === 'function',
            chargerCanClearProfile: typeof charger.clearChargingProfile === 'function',
            chargerCanReset: typeof charger.reset === 'function',
            now: sessionNowMs,
          },
          SESSION_RECONCILE,
        )
        sessionStates.set(lpId, dec.next)
        if (dec.action.kind !== 'none') {
          log.warn(
            {
              loadpoint: lpId,
              action: dec.action.kind,
              attempt: dec.next.totalActions,
              status: r.state.status,
              drawingA: r.state.currentA,
              commandedA,
            },
            `session reconcile: ${dec.reason}`,
          )
          await executeSessionAction(
            dec.action,
            { charger, vehicle, reassertLimitA: commandedA },
            log,
          )
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

  // Declarative reconcile seam: API config writes rebuild the affected module from the effective
  // config and mutate `config` in place (see core/reconcile.ts).
  const reconcile = createReconciler({
    base: baseConfig,
    config,
    db,
    ctx,
    events,
    health,
    chargers,
    tariffs,
    meterReaders,
    vehicles,
    balancers,
    loadpointStates,
    chargerLimitMap,
    chargerUnsubs,
    wireChargerStatus,
    rebuildCircuits,
  })

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
    reconcile,
    onModeChange: handleModeChange,
    onTargetChange: handleTargetChange,
    onPlansChanged: handlePlansChanged,
  })
  log.info({ port: config.site.port }, 'HTTP server listening')

  // Wire REST mode/target handlers
  events.on('loadpoint.mode', (payload) => {
    const p = payload as { name: string; mode: ChargeMode }
    const charger = chargers.get(config.loadpoints.find((l) => l.name === p.name)?.charger ?? '')
    if (charger) setHealth(p.name, charger.health())
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
  if (config.mqttBridge) {
    startMqttBridge(
      config.mqttBridge,
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
    log.info({ host: config.mqttBridge.broker.host }, 'MQTT bridge starting')
  }

  // Single control loop: one damped tick drives every circuit (balancer-backed or bare), so
  // smart mode works with or without a balancer. Interval is kept slow (default 30 s) because a
  // charger/car takes 15–30 s to act on a new limit — ticking faster just makes it oscillate.
  void runAllCircuits() // immediate first tick
  const controlInterval = setInterval(
    () => void runAllCircuits(),
    config.smartCharging.controlIntervalSec * 1000,
  )

  // Rotate the runtime log ring: prune now, then hourly. Retention (days) is re-read each run, so a UI
  // change applies within the hour (and immediately via PUT /api/logs/config).
  pruneLogs(db, getLogRetentionDays(db))
  const logPruneInterval = setInterval(() => pruneLogs(db, getLogRetentionDays(db)), 3600_000)
  log.info(
    { intervalSec: config.smartCharging.controlIntervalSec, circuits: circuits.length },
    'control loop started',
  )

  // Periodic health sweep: re-evaluate every module's health() and emit `health.changed` on any
  // transition (through setHealth). Catches staleness-driven changes that no event would otherwise
  // fire — a tariff going stale at the publish window, a vehicle after failed polls — so the status
  // view stays live + honest instead of poll-only + stale. Runs now (seeds the SSE stream) then 15 s.
  const sweepHealth = (): void => {
    for (const [id, m] of chargers) setHealth(id, m.health())
    for (const [id, m] of tariffs) setHealth(id, m.health())
    for (const [id, m] of meterReaders) setHealth(id, m.health())
    for (const [id, m] of vehicles) setHealth(id, m.health())
    for (const [id, m] of balancers) setHealth(id, m.health())
  }
  sweepHealth()
  const healthSweepInterval = setInterval(sweepHealth, 15_000)

  log.info('OpenSmartCharge ready')

  const shutdown = () => {
    log.info('shutting down gracefully')
    clearInterval(controlInterval)
    clearInterval(logPruneInterval)
    clearInterval(healthSweepInterval)
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

// Parse "HH:MM" into the next occurrence of that time in the SITE-local wall-clock (today or
// tomorrow) — matching how the night window + plans are reasoned about. Previously used
// server-local setHours, which was only correct when the host TZ happened to be the site TZ.
function parseTargetTime(hhmm: string, tz: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  const now = new Date()
  return new Date(now.getTime() + msUntilLocalTime(now, h, m, tz))
}

main().catch((err) => {
  console.error('fatal startup error', err)
  process.exit(1)
})
