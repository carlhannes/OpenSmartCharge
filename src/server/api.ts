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
import { getTimezone, setTimezone } from '../core/settings.js'
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

// DTO for ui2: id as a string, loadpointName (ui2 maps → chargerId), rest pass through.
function toPlanDto(p: Plan) {
  return {
    id: String(p.id),
    loadpointName: p.loadpointName,
    days: p.days,
    readyBy: p.readyBy,
    target: p.target,
    unit: p.unit,
    enabled: p.enabled,
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

  // GET /api/loadpoints
  router.get('/loadpoints', (_req: Request, res: Response) => {
    res.json([...deps.loadpoints.values()])
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

  // ── Charging plans (per loadpoint) ──────────────────────────────────────────

  // GET /api/loadpoints/:name/plans
  router.get('/loadpoints/:name/plans', (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!deps.loadpoints.has(name)) {
      res.status(404).json({ error: 'loadpoint not found' })
      return
    }
    res.json(listPlans(deps.db, name).map(toPlanDto))
  })

  // POST /api/loadpoints/:name/plans — create a plan
  router.post('/loadpoints/:name/plans', (req: Request, res: Response) => {
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
    res.status(201).json(toPlanDto(plan))
  })

  // PUT /api/loadpoints/:name/plans/:id — partial update (only provided fields change)
  router.put('/loadpoints/:name/plans/:id', (req: Request, res: Response) => {
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
    res.json(toPlanDto(updated!))
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
      site: c.site,
      loadpoints: c.loadpoints.map((lp) => ({
        name: lp.name,
        charger: lp.charger,
        balancer: lp.balancer,
        tariff: lp.tariff,
        vehicle: lp.vehicle,
        maxCurrentA:
          (c.chargers.find((ch) => ch.name === lp.charger) as { maxA?: number } | undefined)
            ?.maxA ?? 16,
        autoStart: lp.autoStart,
        targetSoc: lp.targetSoc,
        targetTime: lp.targetTime,
        targetKWh: lp.targetKWh,
      })),
      chargers: c.chargers.map((ch) => ({
        name: ch.name,
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

  return router
}
