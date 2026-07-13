import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type { LoadpointState } from '../core/loadpoint.js'
import type { EventBus } from '../core/events.js'
import { getHealthSummary } from '../core/health.js'
import type { HealthMap } from '../core/health.js'
import type { ChargeMode, Config } from '../core/config.js'
import type { Tariff } from '../sdk/tariff.js'
import type { MeterReader } from '../sdk/meter-reader.js'
import type { Balancer } from '../sdk/balancer.js'
import type { Vehicle } from '../sdk/vehicle.js'
import type { Charger } from '../sdk/charger.js'
import {
  getTimezone,
  setTimezone,
  getLogRetentionDays,
  setLogRetentionDays,
} from '../core/settings.js'
import { queryLogs, pruneLogs, exportLogsText, type LogLevel } from '../core/log-store.js'
import type { Reconciler } from '../core/reconcile.js'
import { setOverride, deleteOverride, validateConfigWith } from '../core/config-overrides.js'
import { getOcppServer } from '../modules/charger-ocpp16/index.js'
import { isValidTimeZone } from '../sdk/local-time.js'
import {
  listPlans,
  createPlan,
  updatePlan,
  deletePlan,
  getPlan,
  DAY_KEYS,
  type Plan,
  type PlanPatch,
  type PlanUnit,
  type DayKey,
} from '../core/plans.js'
import { targetToSoc, availableUnits, type EnergyReading } from '../core/smart-charging/energy.js'

/** Placeholder shown in place of a secret in redacted responses/exports. On import, a field equal to
 *  this is treated as "unchanged" so a redacted round-trip never clobbers the real credential. */
export const REDACTED = '••••••'

export interface ApiDeps {
  db: DatabaseSync
  events: EventBus
  health: HealthMap
  loadpoints: Map<string, LoadpointState>
  chargers: Map<string, Charger>
  config: Config
  tariffs: Map<string, Tariff>
  meterReaders: Map<string, MeterReader>
  balancers: Map<string, Balancer>
  vehicles: Map<string, Vehicle>
  lastTickByBalancer: Map<string, { allocations: Record<string, number>; freeAmps: number }>
  /** Declarative reconcile seam — soft-reload a module after a config override write. */
  reconcile: Reconciler
  onModeChange(name: string, mode: ChargeMode): Promise<void>
  onTargetChange(
    name: string,
    soc?: number,
    time?: string,
    kwh?: number,
    minSoc?: number,
  ): Promise<void>
  /** Called after any plan create/update/delete so the lifecycle can emit SSE + re-tick. */
  onPlansChanged(loadpointName: string): void
}

const HHMM = /^\d{2}:\d{2}$/
const DAY_SET = new Set<string>(DAY_KEYS)

function parsePlanDays(v: unknown): DayKey[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const ok = v.every((d) => typeof d === 'string' && DAY_SET.has(d))
  return ok ? (v as DayKey[]) : null
}

function parsePlanUnit(v: unknown): PlanUnit | null {
  return v === 'pct' || v === 'km' || v === 'kwh' ? v : null
}

// pct is a 0–100 SoC; km/kWh just need to be positive.
function validPlanTarget(unit: PlanUnit, target: number): boolean {
  return unit === 'pct' ? target > 0 && target <= 100 : target > 0
}

// DTO for ui2: id as a string, loadpointName (ui2 maps → chargerId), rest pass through, plus
// resolvedSoc — the backend-computed display % (the single value ui2 shows). null for kwh / no car.
function toPlanDto(p: Plan, reading: EnergyReading) {
  return {
    id: String(p.id),
    loadpointName: p.loadpointName,
    days: p.days,
    readyBy: p.readyBy,
    target: p.target,
    unit: p.unit,
    enabled: p.enabled,
    resolvedSoc: targetToSoc({ unit: p.unit, value: p.target }, reading),
  }
}

export function createApiRouter(deps: ApiDeps): Router {
  const router = createRouter()

  // Resolve the charger for a loadpoint route param. The `chargers` map is keyed by CHARGER
  // name, not loadpoint name, so look up the loadpoint's `charger` ref first — otherwise these
  // commands 404 whenever the loadpoint and charger are named differently.
  const chargerForLoadpoint = (loadpointName: string) => {
    const lp = deps.config.loadpoints.find((l) => l.name === loadpointName)
    return lp ? deps.chargers.get(lp.charger) : undefined
  }

  // The bound vehicle's freshest cached reading (no network) for a loadpoint — soc/range for the km
  // conversion + display, capacity to size energy. {} when the loadpoint has no vehicle.
  const vehicleReadingForLoadpoint = async (name: string): Promise<EnergyReading> => {
    const lp = deps.config.loadpoints.find((l) => l.name === name)
    const veh = lp?.vehicle ? deps.vehicles.get(lp.vehicle) : undefined
    if (!veh) return {}
    const data = await veh.getData().catch(() => undefined)
    return { soc: data?.soc, range: data?.range, capacity: veh.getCachedCapacity() }
  }

  // GET /api/loadpoints — each loadpoint carries availableTargetUnits (which target units its data
  // sources can back right now): kwh always; pct with SoC+capacity; km also needs range.
  router.get('/loadpoints', async (_req: Request, res: Response) => {
    const out = await Promise.all(
      [...deps.loadpoints.values()].map(async (state) => ({
        ...state,
        availableTargetUnits: availableUnits(await vehicleReadingForLoadpoint(state.name)),
      })),
    )
    res.json(out)
  })

  // GET /api/loadpoints/:name
  router.get('/loadpoints/:name', (req: Request, res: Response) => {
    const state = deps.loadpoints.get(String(req.params.name))
    if (!state) {
      res.status(404).json({ error: 'loadpoint not found' })
      return
    }
    res.json(state)
  })

  // GET /api/settings — system-wide settings (currently the site timezone).
  router.get('/settings', (_req: Request, res: Response) => {
    res.json({ timezone: getTimezone(deps.db) })
  })

  // PUT /api/settings — persist system settings. The UI setup flow posts the auto-detected browser
  // timezone here. Read live each control tick, so it applies without a restart.
  router.put('/settings', (req: Request, res: Response) => {
    const body = req.body as { timezone?: unknown }
    const timezone = typeof body.timezone === 'string' ? body.timezone : undefined
    if (timezone === undefined || !isValidTimeZone(timezone)) {
      res.status(400).json({ error: 'timezone must be a valid IANA timezone' })
      return
    }
    setTimezone(deps.db, timezone)
    deps.events.emit('settings.changed', { timezone })
    res.json({ timezone })
  })

  // ── Runtime structural config (persist an override, then reconcile soft-reloads the module) ──
  // Each validates, writes to config_overrides, and calls the reconcile seam, which mutates the
  // effective config in place + emits `config.changed` (forwarded to SSE via the `*` wildcard).

  // PUT /api/site — the site-level main breaker (amps per phase, the circuit ceiling for
  // balancer-less loadpoints). Read live each control tick, so it applies without a restart.
  router.put('/site', (req: Request, res: Response) => {
    const b = req.body as { name?: unknown; port?: unknown; mainBreakerA?: unknown }
    const patch: Record<string, unknown> = {}
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || !b.name.trim()) {
        res.status(400).json({ error: 'name must be a non-empty string' })
        return
      }
      patch.name = b.name.trim()
    }
    if (b.port !== undefined) {
      if (typeof b.port !== 'number' || !Number.isInteger(b.port) || b.port < 1 || b.port > 65535) {
        res.status(400).json({ error: 'port must be an integer 1–65535' })
        return
      }
      patch.port = b.port
    }
    if (b.mainBreakerA !== undefined) {
      if (typeof b.mainBreakerA !== 'number' || !(b.mainBreakerA > 0)) {
        res.status(400).json({ error: 'mainBreakerA must be a positive number' })
        return
      }
      patch.mainBreakerA = b.mainBreakerA
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'nothing to update (name, port, and/or mainBreakerA)' })
      return
    }
    // Validate the merged config BEFORE persisting so a bad value is rejected, not stored + thrown on
    // the next boot.
    try {
      validateConfigWith(deps.config, [{ kind: 'site', name: 'site', patch }])
    } catch {
      res.status(400).json({ error: 'invalid site config' })
      return
    }
    setOverride(deps.db, 'site', 'site', patch)
    deps.reconcile.reloadSite()
    // port is captured at boot (HTTP listen); it persists but only takes effect on restart.
    const restartFields = 'port' in patch ? ['port'] : []
    res.json({
      site: { ...deps.config.site, timezone: getTimezone(deps.db) },
      ...(restartFields.length ? { restartRequired: true, restartFields } : {}),
    })
  })

  // PUT /api/smartcharging — tune the control-loop / degradation knobs (all optional; a partial patch
  // merges). Applies live from the next tick, EXCEPT controlIntervalSec (captured by the boot
  // setInterval → restart-required, flagged in the response).
  router.put('/smartcharging', (req: Request, res: Response) => {
    const patch = req.body as Record<string, unknown>
    if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'body must be a non-empty smartCharging patch' })
      return
    }
    try {
      validateConfigWith(deps.config, [{ kind: 'smartCharging', name: 'smartCharging', patch }])
    } catch {
      res.status(400).json({ error: 'invalid smartCharging config' })
      return
    }
    setOverride(deps.db, 'smartCharging', 'smartCharging', patch)
    deps.reconcile.reloadSmartCharging()
    const restartFields = 'controlIntervalSec' in patch ? ['controlIntervalSec'] : []
    res.json({
      smartCharging: deps.config.smartCharging,
      ...(restartFields.length ? { restartRequired: true, restartFields } : {}),
    })
  })

  // PUT /api/mqtt-bridge — OSC's outbound MQTT/Home-Assistant bridge. Persists as an override but is
  // NOT live-reloadable yet (the bridge is started once at boot with no teardown handle) → always
  // restart-required. Send the full block (broker{host[,port,user,password]}, topicPrefix?,
  // homeAssistantDiscovery?).
  router.put('/mqtt-bridge', (req: Request, res: Response) => {
    const patch = req.body as Record<string, unknown>
    if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'body must be a non-empty mqttBridge config' })
      return
    }
    try {
      validateConfigWith(deps.config, [{ kind: 'mqttBridge', name: 'mqttBridge', patch }])
    } catch {
      res.status(400).json({ error: 'invalid mqttBridge config (broker.host is required)' })
      return
    }
    setOverride(deps.db, 'mqttBridge', 'mqttBridge', patch)
    res.json({ restartRequired: true, restartFields: ['mqttBridge'] })
  })

  // POST /api/meters — add a live-household-current meter reader (listen-only). PUT edits, DELETE
  // removes. Reconciled live (build-new → swap → stop-old), like tariffs.
  router.post('/meters', async (req: Request, res: Response) => {
    const b = req.body as { name?: unknown; type?: unknown } & Record<string, unknown>
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    const type = typeof b.type === 'string' ? b.type.trim() : ''
    if (!name || !type) {
      res.status(400).json({ error: 'name and type are required' })
      return
    }
    if (deps.config.meterReaders.some((m) => m.name === name)) {
      res.status(409).json({ error: `meter "${name}" already exists` })
      return
    }
    const patch: Record<string, unknown> = { ...b }
    delete patch.name
    try {
      validateConfigWith(deps.config, [{ kind: 'meterReader', name, patch }])
    } catch {
      res.status(400).json({ error: 'invalid meter reader config' })
      return
    }
    setOverride(deps.db, 'meterReader', name, patch)
    await deps.reconcile.reloadMeterReader(name)
    res.status(201).json({ name, type })
  })

  router.put('/meters/:name', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!deps.config.meterReaders.some((m) => m.name === name)) {
      res.status(404).json({ error: 'meter not found' })
      return
    }
    const patch = req.body as Record<string, unknown>
    if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'body must be a non-empty meter patch' })
      return
    }
    try {
      validateConfigWith(deps.config, [{ kind: 'meterReader', name, patch }])
    } catch {
      res.status(400).json({ error: 'invalid meter reader config' })
      return
    }
    setOverride(deps.db, 'meterReader', name, patch)
    await deps.reconcile.reloadMeterReader(name)
    res.json({ name })
  })

  router.delete('/meters/:name', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!deps.config.meterReaders.some((m) => m.name === name)) {
      res.status(404).json({ error: 'meter not found' })
      return
    }
    deleteOverride(deps.db, 'meterReader', name)
    await deps.reconcile.removeMeterReader(name)
    res.json({ removed: name })
  })

  // POST /api/tariffs — add a new tariff (PUT /api/tariffs/:name edits an existing one's zone).
  router.post('/tariffs', async (req: Request, res: Response) => {
    const b = req.body as { name?: unknown; type?: unknown } & Record<string, unknown>
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    const type = typeof b.type === 'string' ? b.type.trim() : ''
    if (!name || !type) {
      res.status(400).json({ error: 'name and type are required' })
      return
    }
    if (deps.config.tariffs.some((t) => t.name === name)) {
      res.status(409).json({ error: `tariff "${name}" already exists` })
      return
    }
    const patch: Record<string, unknown> = { ...b }
    delete patch.name
    try {
      validateConfigWith(deps.config, [{ kind: 'tariff', name, patch }])
    } catch {
      res.status(400).json({ error: 'invalid tariff config' })
      return
    }
    setOverride(deps.db, 'tariff', name, patch)
    await deps.reconcile.reloadTariff(name)
    res.status(201).json({ name, type })
  })

  // POST /api/balancers — add a new balancer (PUT /api/balancers/:name edits an existing one).
  router.post('/balancers', async (req: Request, res: Response) => {
    const b = req.body as { name?: unknown; type?: unknown } & Record<string, unknown>
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    const type = typeof b.type === 'string' ? b.type.trim() : ''
    if (!name || !type) {
      res.status(400).json({ error: 'name and type are required' })
      return
    }
    if (deps.config.balancers.some((x) => x.name === name)) {
      res.status(409).json({ error: `balancer "${name}" already exists` })
      return
    }
    const patch: Record<string, unknown> = { ...b }
    delete patch.name
    try {
      validateConfigWith(deps.config, [{ kind: 'balancer', name, patch }])
    } catch {
      res.status(400).json({ error: 'invalid balancer config' })
      return
    }
    setOverride(deps.db, 'balancer', name, patch)
    await deps.reconcile.reloadBalancer(name)
    res.status(201).json({ name, type })
  })

  // PUT /api/tariffs/:name — the price zone/region (e.g. SE3 → SE4). Reloads the tariff module,
  // which re-fetches the new zone immediately (brief gap degrades to the price fallback).
  router.put('/tariffs/:name', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!deps.config.tariffs.some((t) => t.name === name)) {
      res.status(404).json({ error: 'tariff not found' })
      return
    }
    const zone = (req.body as { zone?: unknown }).zone
    if (typeof zone !== 'string' || !zone.trim()) {
      res.status(400).json({ error: 'zone must be a non-empty string' })
      return
    }
    setOverride(deps.db, 'tariff', name, { zone })
    await deps.reconcile.reloadTariff(name)
    const t = deps.config.tariffs.find((x) => x.name === name)!
    res.json({ name, type: t.type, zone: (t as { zone?: string }).zone })
  })

  // PUT /api/balancers/:name — circuit breaker + phase/limit params (partial; send only what changed).
  router.put('/balancers/:name', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!deps.config.balancers.some((b) => b.name === name)) {
      res.status(404).json({ error: 'balancer not found' })
      return
    }
    const body = req.body as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    if (body.mainBreakerA !== undefined) {
      if (typeof body.mainBreakerA !== 'number' || !(body.mainBreakerA > 0)) {
        res.status(400).json({ error: 'mainBreakerA must be a positive number' })
        return
      }
      patch.mainBreakerA = body.mainBreakerA
    }
    if (body.nightMarginA !== undefined) {
      if (typeof body.nightMarginA !== 'number' || body.nightMarginA < 0) {
        res.status(400).json({ error: 'nightMarginA must be a number ≥ 0' })
        return
      }
      patch.nightMarginA = body.nightMarginA
    }
    if (body.daytimeFraction !== undefined) {
      if (
        typeof body.daytimeFraction !== 'number' ||
        body.daytimeFraction <= 0 ||
        body.daytimeFraction > 1
      ) {
        res.status(400).json({ error: 'daytimeFraction must be a number in (0, 1]' })
        return
      }
      patch.daytimeFraction = body.daytimeFraction
    }
    if (body.phases !== undefined) {
      const p = body.phases
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 3) {
        res.status(400).json({ error: 'phases must be an integer 1–3' })
        return
      }
      patch.phases = p
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'no editable balancer fields provided' })
      return
    }
    setOverride(deps.db, 'balancer', name, patch)
    await deps.reconcile.reloadBalancer(name)
    const b = deps.config.balancers.find((x) => x.name === name)!
    res.json({ name, type: b.type, mainBreakerA: b.mainBreakerA, phases: b.phases })
  })

  // ── Charger management (OCPP): claim a pending connection, edit, remove ──────

  // GET /api/chargers/pending — chargers connected over OCPP but not yet claimed/configured.
  router.get('/chargers/pending', (_req: Request, res: Response) => {
    res.json(getOcppServer()?.listPending() ?? [])
  })

  // POST /api/chargers — claim a station: create the charger + its loadpoint (a charger with no
  // loadpoint does nothing), register the station on the OCPP server, and wire it live. The
  // already-connected socket becomes controllable immediately; the next tick commands it.
  router.post('/chargers', async (req: Request, res: Response) => {
    const b = req.body as {
      stationId?: unknown
      name?: unknown
      maxA?: unknown
      phases?: unknown
      tariff?: unknown
      balancer?: unknown
      vehicle?: unknown
    }
    const stationId = typeof b.stationId === 'string' ? b.stationId.trim() : ''
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!stationId || !name) {
      res.status(400).json({ error: 'stationId and name are required' })
      return
    }
    if (deps.config.chargers.some((c) => c.name === name) || deps.loadpoints.has(name)) {
      res.status(409).json({ error: `name "${name}" already in use` })
      return
    }
    const maxA = b.maxA === undefined ? 16 : b.maxA
    if (typeof maxA !== 'number' || !Number.isInteger(maxA) || maxA <= 0) {
      res.status(400).json({ error: 'maxA must be a positive integer' })
      return
    }
    const phases = b.phases === undefined ? 3 : b.phases
    if (typeof phases !== 'number' || ![1, 2, 3].includes(phases)) {
      res.status(400).json({ error: 'phases must be 1, 2 or 3' })
      return
    }
    const refName = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    // loadpoint name == charger name (one-loadpoint-per-charger convention).
    setOverride(deps.db, 'charger', name, { type: 'ocpp16', stationId, maxA, phases })
    setOverride(deps.db, 'loadpoint', name, {
      charger: name,
      tariff: refName(b.tariff),
      balancer: refName(b.balancer),
      vehicle: refName(b.vehicle),
      defaultMode: 'smart',
    })
    await deps.reconcile.addCharger(name)
    deps.reconcile.addLoadpoint(name)
    getOcppServer()?.setLoadpointName(stationId, name) // transaction attribution
    res.status(201).json({ name, stationId, maxA, phases })
  })

  // PUT /api/chargers/:name — edit a charger's label / max current (identity is immutable).
  router.put('/chargers/:name', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!deps.config.chargers.some((c) => c.name === name)) {
      res.status(404).json({ error: 'charger not found' })
      return
    }
    const b = req.body as { label?: unknown; maxA?: unknown }
    const patch: Record<string, unknown> = {}
    if (b.label !== undefined) {
      if (typeof b.label !== 'string') {
        res.status(400).json({ error: 'label must be a string' })
        return
      }
      patch.label = b.label
    }
    if (b.maxA !== undefined) {
      if (typeof b.maxA !== 'number' || !Number.isInteger(b.maxA) || b.maxA <= 0) {
        res.status(400).json({ error: 'maxA must be a positive integer' })
        return
      }
      patch.maxA = b.maxA
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'nothing to update (label and/or maxA)' })
      return
    }
    setOverride(deps.db, 'charger', name, patch)
    await deps.reconcile.reloadCharger(name)
    res.json({ name, ...patch })
  })

  // DELETE /api/chargers/:name — remove the charger + its loadpoint(s). The WS (if open) reverts to
  // pending so it can be re-claimed. (A charger defined in osc.yaml returns on the next reboot.)
  router.delete('/chargers/:name', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    const chargerCfg = deps.config.chargers.find((c) => c.name === name)
    if (!chargerCfg) {
      res.status(404).json({ error: 'charger not found' })
      return
    }
    // Refuse to delete a charger mid-session unless forced — yanking it out from under an active
    // transaction would strand the car. Disabling the loadpoint first stops charging cleanly (next
    // tick commands 0 A). ?force=true overrides for the rare "the hardware is already gone" case.
    if (String(req.query.force) !== 'true') {
      const active = deps.config.loadpoints
        .filter((l) => l.charger === name && deps.loadpoints.get(l.name)?.charging)
        .map((l) => l.name)
      if (active.length > 0) {
        res.status(409).json({
          error: `charger '${name}' has an active charging session (${active.join(', ')})`,
          hint: 'Please disable this charger before deleting it.',
        })
        return
      }
    }
    const stationId = (chargerCfg as { stationId?: string }).stationId
    // Snapshot referencing loadpoints before removeLoadpoint mutates config.loadpoints.
    for (const lp of deps.config.loadpoints.filter((l) => l.charger === name)) {
      deps.reconcile.removeLoadpoint(lp.name)
      deleteOverride(deps.db, 'loadpoint', lp.name)
    }
    await deps.reconcile.removeCharger(name)
    if (stationId) getOcppServer()?.unregisterStation(stationId)
    deleteOverride(deps.db, 'charger', name)
    res.status(204).end()
  })

  // ── Vehicle management: add (with provider credentials), remove, bind to a loadpoint ────────

  // POST /api/vehicles — add a vehicle with provider credentials. Creds are stored in the DB
  // (config_overrides) and NEVER returned or logged. Auth + first fetch run in the background so the
  // slow provider login doesn't block the response — poll GET /api/vehicles/:name for status.
  router.post('/vehicles', async (req: Request, res: Response) => {
    const b = req.body as {
      name?: unknown
      type?: unknown
      username?: unknown
      password?: unknown
      vin?: unknown
    }
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    const type = typeof b.type === 'string' && b.type.trim() ? b.type.trim() : 'skoda'
    const username = typeof b.username === 'string' ? b.username : ''
    const password = typeof b.password === 'string' ? b.password : ''
    const vin = typeof b.vin === 'string' ? b.vin.trim().toUpperCase() : ''
    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }
    if (deps.vehicles.has(name) || deps.config.vehicles.some((v) => v.name === name)) {
      res.status(409).json({ error: `name "${name}" already in use` })
      return
    }
    if (type !== 'skoda') {
      res.status(400).json({ error: 'only vehicle type "skoda" is supported' })
      return
    }
    if (!username || !password) {
      res.status(400).json({ error: 'username and password are required' })
      return
    }
    if (vin.length !== 17) {
      res.status(400).json({ error: 'vin must be 17 characters' })
      return
    }
    setOverride(deps.db, 'vehicle', name, { type, username, password, vin })
    await deps.reconcile.addVehicle(name)
    void deps.vehicles
      .get(name)
      ?.refresh()
      .catch(() => {}) // background auth + fetch
    res.status(201).json({ name, type, vin }) // never echo credentials
  })

  // DELETE /api/vehicles/:name — remove a vehicle + drop its cached data. A loadpoint bound to it
  // falls back to no-SoC (graceful).
  router.delete('/vehicles/:name', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!deps.vehicles.has(name) && !deps.config.vehicles.some((v) => v.name === name)) {
      res.status(404).json({ error: 'vehicle not found' })
      return
    }
    await deps.reconcile.removeVehicle(name)
    deleteOverride(deps.db, 'vehicle', name)
    deps.db.prepare('DELETE FROM vehicle_cache WHERE vehicle_name = ?').run(name)
    res.status(204).end()
  })

  // PUT /api/loadpoints/:name — bind a vehicle (and/or tariff/balancer) to a loadpoint. The ref must
  // exist; resolveLoadpoint reads the binding live, so no module rebuild is needed.
  router.put('/loadpoints/:name', (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!deps.loadpoints.has(name)) {
      res.status(404).json({ error: 'loadpoint not found' })
      return
    }
    const b = req.body as { vehicle?: unknown; tariff?: unknown; balancer?: unknown }
    const refs = [
      ['vehicle', b.vehicle, deps.vehicles] as const,
      ['tariff', b.tariff, deps.tariffs] as const,
      ['balancer', b.balancer, deps.balancers] as const,
    ]
    const patch: Record<string, unknown> = {}
    for (const [field, val, pool] of refs) {
      if (val === undefined) continue
      if (typeof val !== 'string' || !val.trim() || !pool.has(val)) {
        res.status(400).json({ error: `${field} must be an existing ${field} name` })
        return
      }
      patch[field] = val
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'nothing to bind (vehicle/tariff/balancer)' })
      return
    }
    setOverride(deps.db, 'loadpoint', name, patch)
    deps.reconcile.reloadLoadpoint(name)
    const lp = deps.config.loadpoints.find((l) => l.name === name)!
    res.json({ name, vehicle: lp.vehicle, tariff: lp.tariff, balancer: lp.balancer })
  })

  // ── Charging plans (per loadpoint) ──────────────────────────────────────────

  // GET /api/loadpoints/:name/plans
  router.get('/loadpoints/:name/plans', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!deps.loadpoints.has(name)) {
      res.status(404).json({ error: 'loadpoint not found' })
      return
    }
    const reading = await vehicleReadingForLoadpoint(name)
    res.json(listPlans(deps.db, name).map((p) => toPlanDto(p, reading)))
  })

  // POST /api/loadpoints/:name/plans — create a plan
  router.post('/loadpoints/:name/plans', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!deps.loadpoints.has(name)) {
      res.status(404).json({ error: 'loadpoint not found' })
      return
    }
    const b = req.body as {
      days?: unknown
      readyBy?: unknown
      target?: unknown
      unit?: unknown
      enabled?: unknown
    }
    const days = parsePlanDays(b.days)
    const unit = parsePlanUnit(b.unit)
    const readyBy = typeof b.readyBy === 'string' && HHMM.test(b.readyBy) ? b.readyBy : null
    const target = typeof b.target === 'number' ? b.target : null
    if (!days || !unit || !readyBy || target === null || !validPlanTarget(unit, target)) {
      res.status(400).json({
        error: 'invalid plan: need days[] (mon..sun), readyBy "HH:MM", unit pct|km|kwh, target > 0',
      })
      return
    }
    const enabled = typeof b.enabled === 'boolean' ? b.enabled : true
    const plan = createPlan(deps.db, name, { days, readyBy, target, unit, enabled })
    deps.onPlansChanged(name)
    res.status(201).json(toPlanDto(plan, await vehicleReadingForLoadpoint(name)))
  })

  // PUT /api/loadpoints/:name/plans/:id — partial update (only provided fields change)
  router.put('/loadpoints/:name/plans/:id', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    const id = Number(req.params.id)
    const existing = getPlan(deps.db, id)
    if (!existing || existing.loadpointName !== name) {
      res.status(404).json({ error: 'plan not found' })
      return
    }
    const b = req.body as {
      days?: unknown
      readyBy?: unknown
      target?: unknown
      unit?: unknown
      enabled?: unknown
    }
    const patch: PlanPatch = {}
    if (b.days !== undefined) {
      const d = parsePlanDays(b.days)
      if (!d) {
        res.status(400).json({ error: 'days must be a non-empty subset of mon..sun' })
        return
      }
      patch.days = d
    }
    if (b.readyBy !== undefined) {
      if (typeof b.readyBy !== 'string' || !HHMM.test(b.readyBy)) {
        res.status(400).json({ error: 'readyBy must be "HH:MM"' })
        return
      }
      patch.readyBy = b.readyBy
    }
    if (b.unit !== undefined) {
      const u = parsePlanUnit(b.unit)
      if (!u) {
        res.status(400).json({ error: 'unit must be pct|km|kwh' })
        return
      }
      patch.unit = u
    }
    if (b.target !== undefined) {
      if (typeof b.target !== 'number') {
        res.status(400).json({ error: 'target must be a number' })
        return
      }
      patch.target = b.target
    }
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' })
        return
      }
      patch.enabled = b.enabled
    }
    const effUnit = patch.unit ?? existing.unit
    const effTarget = patch.target ?? existing.target
    if (!validPlanTarget(effUnit, effTarget)) {
      res.status(400).json({ error: 'target out of range for unit' })
      return
    }
    const updated = updatePlan(deps.db, id, patch)
    deps.onPlansChanged(name)
    res.json(toPlanDto(updated!, await vehicleReadingForLoadpoint(name)))
  })

  // DELETE /api/loadpoints/:name/plans/:id
  router.delete('/loadpoints/:name/plans/:id', (req: Request, res: Response) => {
    const name = String(req.params.name)
    const id = Number(req.params.id)
    const existing = getPlan(deps.db, id)
    if (!existing || existing.loadpointName !== name) {
      res.status(404).json({ error: 'plan not found' })
      return
    }
    deletePlan(deps.db, id)
    deps.onPlansChanged(name)
    res.status(204).end()
  })

  // POST /api/loadpoints/:name/mode
  router.post('/loadpoints/:name/mode', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!deps.loadpoints.has(name)) {
      res.status(404).json({ error: 'loadpoint not found' })
      return
    }

    const { mode } = req.body as { mode?: string }
    if (mode !== 'smart' && mode !== 'fast' && mode !== 'disabled') {
      res.status(400).json({ error: 'mode must be smart | fast | disabled' })
      return
    }

    await deps.onModeChange(name, mode as ChargeMode)
    res.json(deps.loadpoints.get(name))
  })

  // POST /api/loadpoints/:name/target
  router.post('/loadpoints/:name/target', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!deps.loadpoints.has(name)) {
      res.status(404).json({ error: 'loadpoint not found' })
      return
    }

    const body = req.body as { soc?: unknown; time?: unknown; kwh?: unknown; minSoc?: unknown }
    const soc = typeof body.soc === 'number' ? body.soc : undefined
    const time = typeof body.time === 'string' ? body.time : undefined
    const kwh = typeof body.kwh === 'number' ? body.kwh : undefined
    const minSoc = typeof body.minSoc === 'number' ? body.minSoc : undefined

    if (soc !== undefined && (soc < 0 || soc > 100)) {
      res.status(400).json({ error: 'soc must be 0–100' })
      return
    }
    if (time !== undefined && !/^\d{2}:\d{2}$/.test(time)) {
      res.status(400).json({ error: 'time must be HH:MM' })
      return
    }
    if (kwh !== undefined && (kwh < 1 || kwh > 100)) {
      res.status(400).json({ error: 'kwh must be 1–100' })
      return
    }
    if (minSoc !== undefined && (minSoc < 0 || minSoc > 100)) {
      res.status(400).json({ error: 'minSoc must be 0–100' })
      return
    }

    await deps.onTargetChange(name, soc, time, kwh, minSoc)
    res.json(deps.loadpoints.get(name))
  })

  // GET /api/tariffs/:name/prices?from=<ISO>&to=<ISO>
  router.get('/tariffs/:name/prices', (req: Request, res: Response) => {
    const tariff = deps.tariffs.get(String(req.params.name))
    if (!tariff) {
      res.status(404).json({ error: 'tariff not found' })
      return
    }
    const from = req.query.from ? new Date(String(req.query.from)) : new Date()
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 48 * 3600_000)
    tariff
      .prices(from, to)
      .then((slots) => res.json(slots))
      .catch(() => res.status(502).json({ error: 'failed to retrieve prices' }))
  })

  // POST /api/tariffs/:name/refresh — force an immediate re-fetch now, bypassing the schedule. The
  // manual recovery for "tomorrow's prices are empty and the scheduled backoff hasn't retried yet".
  // Best-effort: the provider swallows fetch errors into its health + a retry, so a 200 with the
  // resulting health tells the caller whether it recovered (ok) or is still degraded/unavailable.
  router.post('/tariffs/:name/refresh', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    const tariff = deps.tariffs.get(name)
    if (!tariff) {
      res.status(404).json({ error: 'tariff not found' })
      return
    }
    if (!tariff.refresh) {
      res.status(501).json({ error: 'tariff does not support manual refresh' })
      return
    }
    await tariff.refresh()
    res.json({ name, health: tariff.health() })
  })

  // GET /api/meters/:name
  router.get('/meters/:name', (req: Request, res: Response) => {
    const reader = deps.meterReaders.get(String(req.params.name))
    if (!reader) {
      res.status(404).json({ error: 'meter not found' })
      return
    }
    res.json({ latest: reader.latest(), health: reader.health() })
  })

  // GET /api/balancers/:name
  router.get('/balancers/:name', (req: Request, res: Response) => {
    const balancer = deps.balancers.get(String(req.params.name))
    if (!balancer) {
      res.status(404).json({ error: 'balancer not found' })
      return
    }
    const last = deps.lastTickByBalancer.get(String(req.params.name))
    res.json({
      name: String(req.params.name),
      health: balancer.health(),
      lastAllocations: last?.allocations ?? null,
      freeAmps: last?.freeAmps ?? null,
    })
  })

  // GET /api/vehicles/:name
  router.get('/vehicles/:name', (req: Request, res: Response) => {
    const vehicle = deps.vehicles.get(String(req.params.name))
    if (!vehicle) {
      res.status(404).json({ error: 'vehicle not found' })
      return
    }
    vehicle
      .getData()
      .then((data) =>
        res.json({
          name: String(req.params.name),
          health: vehicle.health(),
          data,
          capacityKWh: vehicle.getCachedCapacity() ?? null,
        }),
      )
      .catch(() =>
        res.json({
          name: String(req.params.name),
          health: vehicle.health(),
          data: null,
          capacityKWh: vehicle.getCachedCapacity() ?? null,
        }),
      )
  })

  // POST /api/vehicles/:name/refresh — force a live poll now (updates the cache the control loop
  // reads). Unlike GET, this hits the real vehicle API, so use it sparingly: over-polling can wake +
  // slowly drain a parked car and risks a provider rate-limit lockout. Useful right after the user
  // starts remote climate, so climate-triggered charging reacts within one control tick.
  router.post('/vehicles/:name/refresh', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    const vehicle = deps.vehicles.get(name)
    if (!vehicle) {
      res.status(404).json({ error: 'vehicle not found' })
      return
    }
    try {
      const data = await vehicle.refresh()
      res.json({
        name,
        health: vehicle.health(),
        data,
        capacityKWh: vehicle.getCachedCapacity() ?? null,
      })
    } catch {
      res.status(502).json({ error: 'vehicle refresh failed', health: vehicle.health() })
    }
  })

  // GET /api/health
  router.get('/health', (_req: Request, res: Response) => {
    res.json(getHealthSummary(deps.health))
  })

  // POST /api/loadpoints/:name/start
  router.post('/loadpoints/:name/start', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    const charger = chargerForLoadpoint(name)
    if (!charger) {
      res.status(404).json({ error: 'loadpoint not found' })
      return
    }
    if (!charger.remoteStart) {
      res.status(400).json({ error: 'charger does not support remote start' })
      return
    }
    await charger.remoteStart()
    res.json(deps.loadpoints.get(name) ?? {})
  })

  // POST /api/loadpoints/:name/stop
  router.post('/loadpoints/:name/stop', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    const charger = chargerForLoadpoint(name)
    if (!charger) {
      res.status(404).json({ error: 'loadpoint not found' })
      return
    }
    if (!charger.remoteStop) {
      res.status(400).json({ error: 'charger does not support remote stop' })
      return
    }
    await charger.remoteStop()
    res.json(deps.loadpoints.get(name) ?? {})
  })

  // POST /api/loadpoints/:name/reset  body { type?: 'Soft' | 'Hard' }
  router.post('/loadpoints/:name/reset', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    const charger = chargerForLoadpoint(name)
    if (!charger) {
      res.status(404).json({ error: 'loadpoint not found' })
      return
    }
    if (!charger.reset) {
      res.status(400).json({ error: 'charger does not support reset' })
      return
    }
    const body = req.body as { type?: unknown }
    const type = body.type === 'Hard' ? 'Hard' : 'Soft'
    await charger.reset(type)
    res.json({ ok: true, type })
  })

  // POST /api/loadpoints/:name/clear-profile — clears all installed charging profiles
  router.post('/loadpoints/:name/clear-profile', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    const charger = chargerForLoadpoint(name)
    if (!charger?.clearChargingProfile) {
      res.status(404).json({ error: 'loadpoint not found or unsupported' })
      return
    }
    res.json(await charger.clearChargingProfile())
  })

  // GET /api/loadpoints/:name/composite-schedule?duration=<sec> — charger's computed limit
  router.get('/loadpoints/:name/composite-schedule', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    const charger = chargerForLoadpoint(name)
    if (!charger?.getCompositeSchedule) {
      res.status(404).json({ error: 'loadpoint not found or unsupported' })
      return
    }
    const duration = Number(req.query.duration ?? 60)
    res.json(await charger.getCompositeSchedule(duration))
  })

  // POST /api/loadpoints/:name/profile  body { amps: number }
  router.post('/loadpoints/:name/profile', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    const charger = chargerForLoadpoint(name)
    if (!charger) {
      res.status(404).json({ error: 'loadpoint not found' })
      return
    }
    if (!charger.setOneShotProfile) {
      res.status(400).json({ error: 'charger does not support one-shot profile' })
      return
    }
    const body = req.body as { amps?: unknown }
    const amps = typeof body.amps === 'number' ? body.amps : undefined
    if (amps === undefined || amps < 0) {
      res.status(400).json({ error: 'amps must be a non-negative number' })
      return
    }
    await charger.setOneShotProfile(amps)
    res.json(deps.loadpoints.get(name) ?? {})
  })

  // GET /api/site
  router.get('/site', (_req: Request, res: Response) => {
    const c = deps.config
    res.json({
      // timezone is a runtime setting (settings KV) that diverges from the osc.yaml seed after a
      // PUT /api/settings — serve the live value so clients see one truth.
      site: { ...c.site, timezone: getTimezone(deps.db) },
      loadpoints: c.loadpoints.map((lp) => {
        // targets/maxCurrentA are RUNTIME state (edited via /loadpoints + /plans and
        // persisted), not config seeds — read the live LoadpointState so /api/site doesn't lie.
        const st = deps.loadpoints.get(lp.name)
        return {
          name: lp.name,
          charger: lp.charger,
          balancer: lp.balancer,
          tariff: lp.tariff,
          vehicle: lp.vehicle,
          maxCurrentA:
            st?.maxCurrentA ??
            (c.chargers.find((ch) => ch.name === lp.charger) as { maxA?: number } | undefined)
              ?.maxA ??
            16,
          targetSoc: st?.targetSoc,
          targetTime: st?.targetTime,
          targetKWh: st?.targetKWh,
          minSoc: st?.minSoc,
        }
      }),
      chargers: c.chargers.map((ch) => ({
        name: ch.name,
        label: (ch as { label?: string }).label ?? ch.name,
        type: ch.type,
        stationId: (ch as { stationId?: string }).stationId,
        maxA: (ch as { maxA?: number }).maxA ?? 16,
      })),
      balancers: c.balancers.map((b) => ({
        name: b.name,
        type: b.type,
        mainBreakerA: b.mainBreakerA,
        phases: b.phases,
      })),
      tariffs: c.tariffs.map((t) => ({
        name: t.name,
        type: t.type,
        zone: (t as { zone?: string }).zone,
      })),
      vehicles: c.vehicles.map((v) => ({
        name: v.name,
        type: v.type,
        vin: (v as { vin?: string }).vin,
      })),
      meterReaders: c.meterReaders.map((m) => ({
        name: m.name,
        type: m.type,
      })),
      smartCharging: c.smartCharging,
      mqttBridge: c.mqttBridge
        ? {
            ...c.mqttBridge,
            // never echo the broker password — redact so the client can display/round-trip it.
            broker: {
              ...c.mqttBridge.broker,
              password: c.mqttBridge.broker.password ? REDACTED : undefined,
            },
          }
        : undefined,
    })
  })

  // GET /api/transactions
  router.get('/transactions', (req: Request, res: Response) => {
    const loadpoint = req.query.loadpoint as string | undefined
    const limit = Math.min(Number(req.query.limit ?? 50), 200)

    const rows = loadpoint
      ? deps.db
          .prepare(`SELECT * FROM transactions WHERE loadpoint_name = ? ORDER BY id DESC LIMIT ?`)
          .all(loadpoint, limit)
      : deps.db.prepare(`SELECT * FROM transactions ORDER BY id DESC LIMIT ?`).all(limit)

    res.json(rows)
  })

  // GET /api/transactions/:id
  router.get('/transactions/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'id must be a positive integer' })
      return
    }
    const tx = deps.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as
      | { meter_start: number | null }
      | undefined
    if (!tx) {
      res.status(404).json({ error: 'transaction not found' })
      return
    }
    // meter_values.energy_kwh is the charger's absolute lifetime register; report each sample as
    // the session-relative delta from meter_start (Wh→kWh), matching latestEnergyKwh + the session
    // list. Without this a cumulative-energy chart would be offset by the whole lifetime register.
    const startKwh = tx.meter_start != null ? tx.meter_start / 1000 : 0
    const samples = deps.db
      .prepare(
        `SELECT measured_at,
                CASE WHEN energy_kwh IS NULL THEN NULL ELSE MAX(0, energy_kwh - ?) END AS energy_kwh,
                power_w, current_a, soc
         FROM meter_values WHERE transaction_id = ? ORDER BY measured_at ASC`,
      )
      .all(startKwh, id)
    res.json({ transaction: tx, samples })
  })

  // GET /api/logs — runtime log ring, newest-first (see core/log-store.ts). All filters optional:
  // level (minimum severity), since/until (ISO), q (substring on msg+module), limit (default 200, cap 500).
  router.get('/logs', (req: Request, res: Response) => {
    res.json(
      queryLogs(deps.db, {
        level: req.query.level as LogLevel | undefined,
        since: req.query.since as string | undefined,
        until: req.query.until as string | undefined,
        q: req.query.q as string | undefined,
        limit: req.query.limit != null ? Number(req.query.limit) : undefined,
      }),
    )
  })

  // GET /api/logs/export — the full filtered set (no viewer limit) as a downloadable .log text file.
  // Honors the same level/since/until/q as GET /api/logs, so it exports exactly the selected state.
  router.get('/logs/export', (req: Request, res: Response) => {
    const text = exportLogsText(deps.db, {
      level: req.query.level as LogLevel | undefined,
      since: req.query.since as string | undefined,
      until: req.query.until as string | undefined,
      q: req.query.q as string | undefined,
    })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    res.set('Content-Type', 'text/plain; charset=utf-8')
    res.set('Content-Disposition', `attachment; filename="osc-logs-${stamp}.log"`)
    res.send(text)
  })

  // GET /api/logs/config — the log-retention window (days).
  router.get('/logs/config', (_req: Request, res: Response) => {
    res.json({ retentionDays: getLogRetentionDays(deps.db) })
  })

  // PUT /api/logs/config — set retention (days, 1–365). Prunes immediately so lowering it takes effect now.
  router.put('/logs/config', (req: Request, res: Response) => {
    const body = req.body as { retentionDays?: unknown }
    const days = typeof body.retentionDays === 'number' ? body.retentionDays : NaN
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      res.status(400).json({ error: 'retentionDays must be an integer 1–365' })
      return
    }
    setLogRetentionDays(deps.db, days)
    pruneLogs(deps.db, days)
    res.json({ retentionDays: days })
  })

  return router
}
