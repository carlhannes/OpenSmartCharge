import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type { LoadpointState } from '../core/loadpoint.js'
import type { EventBus } from '../core/events.js'
import { getHealthSummary } from '../core/health.js'
import type { HealthMap } from '../core/health.js'
import type { ChargeMode } from '../core/config.js'
import type { Tariff } from '../sdk/tariff.js'
import type { MeterReader } from '../sdk/meter-reader.js'
import type { Balancer } from '../sdk/balancer.js'

export interface ApiDeps {
  db: DatabaseSync
  events: EventBus
  health: HealthMap
  loadpoints: Map<string, LoadpointState>
  chargers: Map<string, { setCurrentLimit(a: number): Promise<void> }>
  tariffs: Map<string, Tariff>
  meterReaders: Map<string, MeterReader>
  balancers: Map<string, Balancer>
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

  // GET /api/health
  router.get('/health', (_req: Request, res: Response) => {
    res.json(getHealthSummary(deps.health))
  })

  // GET /api/transactions
  router.get('/transactions', (req: Request, res: Response) => {
    const loadpoint = req.query.loadpoint as string | undefined
    const limit = Math.min(Number(req.query.limit ?? 50), 200)

    const rows = loadpoint
      ? deps.db
          .prepare(
            `SELECT * FROM transactions WHERE loadpoint_name = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(loadpoint, limit)
      : deps.db.prepare(`SELECT * FROM transactions ORDER BY id DESC LIMIT ?`).all(limit)

    res.json(rows)
  })

  return router
}

