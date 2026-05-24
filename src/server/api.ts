import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type { LoadpointState } from '../core/loadpoint.js'
import { setLoadpointMode, setLoadpointTarget } from '../core/loadpoint.js'
import type { EventBus } from '../core/events.js'
import { getHealthSummary } from '../core/health.js'
import type { HealthMap } from '../core/health.js'
import type { ChargeMode } from '../core/config.js'

export interface ApiDeps {
  db: DatabaseSync
  events: EventBus
  health: HealthMap
  loadpoints: Map<string, LoadpointState>
  chargers: Map<string, { setCurrentLimit(a: number): Promise<void> }>
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
    const state = deps.loadpoints.get(String(req.params.name))
    if (!state) {
      res.status(404).json({ error: 'loadpoint not found' })
      return
    }

    const { mode } = req.body as { mode?: string }
    if (mode !== 'smart' && mode !== 'fast' && mode !== 'disabled') {
      res.status(400).json({ error: 'mode must be smart | fast | disabled' })
      return
    }

    state.mode = mode as ChargeMode
    setLoadpointMode(deps.db, state.name, mode)
    deps.events.emit('loadpoint.mode', { name: state.name, mode })

    const charger = deps.chargers.get(state.name)
    if (charger) {
      await applyModeToCharger(mode, charger, state)
    }

    res.json(state)
  })

  // POST /api/loadpoints/:name/target
  router.post('/loadpoints/:name/target', (req: Request, res: Response) => {
    const state = deps.loadpoints.get(String(req.params.name))
    if (!state) {
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

    state.targetSoc = soc
    state.targetTime = time
    setLoadpointTarget(deps.db, state.name, soc, time)
    deps.events.emit('loadpoint.target', { name: state.name, targetSoc: soc, targetTime: time })

    res.json(state)
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

async function applyModeToCharger(
  mode: ChargeMode,
  charger: { setCurrentLimit(a: number): Promise<void> },
  state: LoadpointState,
): Promise<void> {
  if (mode === 'disabled') {
    await charger.setCurrentLimit(0)
  } else {
    // smart behaves like fast in M1 (no balancer yet) — charge at max
    await charger.setCurrentLimit(state.maxCurrentA ?? 16)
  }
}
