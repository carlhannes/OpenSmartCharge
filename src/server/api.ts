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
  onTargetChange(name: string, soc?: number, time?: string): Promise<void>
}

export function createApiRouter(deps: ApiDeps): Router {
  const router = createRouter()

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

    const body = req.body as { soc?: unknown; time?: unknown }
    const soc = typeof body.soc === 'number' ? body.soc : undefined
    const time = typeof body.time === 'string' ? body.time : undefined

    if (soc !== undefined && (soc < 0 || soc > 100)) {
      res.status(400).json({ error: 'soc must be 0–100' })
      return
    }
    if (time !== undefined && !/^\d{2}:\d{2}$/.test(time)) {
      res.status(400).json({ error: 'time must be HH:MM' })
      return
    }

    await deps.onTargetChange(name, soc, time)
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
    const charger = deps.chargers.get(name)
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
    const charger = deps.chargers.get(name)
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
    const charger = deps.chargers.get(name)
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
    const charger = deps.chargers.get(name)
    if (!charger?.clearChargingProfile) {
      res.status(404).json({ error: 'loadpoint not found or unsupported' })
      return
    }
    res.json(await charger.clearChargingProfile())
  })

  // GET /api/loadpoints/:name/composite-schedule?duration=<sec> — charger's computed limit
  router.get('/loadpoints/:name/composite-schedule', async (req: Request, res: Response) => {
    const name = String(req.params.name)
    const charger = deps.chargers.get(name)
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
    const charger = deps.chargers.get(name)
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
    const tx = deps.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id)
    if (!tx) {
      res.status(404).json({ error: 'transaction not found' })
      return
    }
    const samples = deps.db
      .prepare(
        'SELECT measured_at, energy_kwh, power_w, current_a, soc FROM meter_values WHERE transaction_id = ? ORDER BY measured_at ASC',
      )
      .all(id)
    res.json({ transaction: tx, samples })
  })

  return router
}
