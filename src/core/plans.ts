import type { DatabaseSync } from 'node:sqlite'
import { localParts, msUntilLocalTime } from '../sdk/local-time.js'

// Recurring, per-loadpoint charging plans. A resolution layer in front of the existing planner:
// the lifecycle picks the governing plan each tick (selectActivePlan) and turns it into the single
// { targetSoc | targetKWh, targetTime } the energy resolver + planner already consume. Weekday-
// recurring only (no one-off/date). Shapes mirror ui2's Plan so the client wiring is a thin map.

export type PlanUnit = 'pct' | 'km' | 'kwh'
export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

// Order defines the bit index in days_mask (bit 0 = mon) AND matches local-time's localWeekday
// (0=Mon..6=Sun) + ui2's DAY_KEYS.
export const DAY_KEYS: readonly DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

export interface Plan {
  id: number
  loadpointName: string
  days: DayKey[]
  readyBy: string // "HH:MM" (site-local)
  target: number
  unit: PlanUnit
  enabled: boolean
}

export interface PlanInput {
  days: DayKey[]
  readyBy: string
  target: number
  unit: PlanUnit
  enabled?: boolean
}

export type PlanPatch = Partial<PlanInput>

// ── weekday mask ⇄ day keys (pure) ───────────────────────────────────────────

export function daysToMask(days: DayKey[]): number {
  return days.reduce((mask, d) => {
    const i = DAY_KEYS.indexOf(d)
    return i >= 0 ? mask | (1 << i) : mask
  }, 0)
}

export function maskToDays(mask: number): DayKey[] {
  return DAY_KEYS.filter((_, i) => (mask & (1 << i)) !== 0)
}

// ── persistence ──────────────────────────────────────────────────────────────

interface PlanRow {
  id: number
  loadpoint_name: string
  days_mask: number
  ready_by: string
  target_value: number
  target_unit: string
  enabled: number
}

function rowToPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    loadpointName: r.loadpoint_name,
    days: maskToDays(r.days_mask),
    readyBy: r.ready_by,
    target: r.target_value,
    unit: r.target_unit as PlanUnit,
    enabled: r.enabled === 1,
  }
}

export function getPlan(db: DatabaseSync, id: number): Plan | undefined {
  const row = db.prepare('SELECT * FROM charge_plans WHERE id = ?').get(id) as PlanRow | undefined
  return row ? rowToPlan(row) : undefined
}

export function listPlans(db: DatabaseSync, loadpointName: string): Plan[] {
  const rows = db
    .prepare('SELECT * FROM charge_plans WHERE loadpoint_name = ? ORDER BY ready_by, id')
    .all(loadpointName) as unknown as PlanRow[]
  return rows.map(rowToPlan)
}

export function createPlan(db: DatabaseSync, loadpointName: string, input: PlanInput): Plan {
  const res = db
    .prepare(
      `INSERT INTO charge_plans (loadpoint_name, days_mask, ready_by, target_value, target_unit, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      loadpointName,
      daysToMask(input.days),
      input.readyBy,
      input.target,
      input.unit,
      input.enabled === false ? 0 : 1,
    )
  return getPlan(db, Number(res.lastInsertRowid))!
}

// Partial update (undefined field = leave unchanged, via COALESCE). Returns the row after, or
// undefined if no such plan.
export function updatePlan(db: DatabaseSync, id: number, patch: PlanPatch): Plan | undefined {
  db.prepare(
    `UPDATE charge_plans SET
       days_mask    = COALESCE(?, days_mask),
       ready_by     = COALESCE(?, ready_by),
       target_value = COALESCE(?, target_value),
       target_unit  = COALESCE(?, target_unit),
       enabled      = COALESCE(?, enabled),
       updated_at   = datetime('now')
     WHERE id = ?`,
  ).run(
    patch.days ? daysToMask(patch.days) : null,
    patch.readyBy ?? null,
    patch.target ?? null,
    patch.unit ?? null,
    patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
    id,
  )
  return getPlan(db, id)
}

export function deletePlan(db: DatabaseSync, id: number): boolean {
  return db.prepare('DELETE FROM charge_plans WHERE id = ?').run(id).changes > 0
}

// ── resolution (pure) ─────────────────────────────────────────────────────────

function readyByMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * The governing plan for `now`: among ENABLED plans whose `days` include today (site-local) and
 * whose `readyBy` is still later today, the earliest `readyBy` wins. Returns undefined when none
 * qualifies (a day-mask excluding today, all today's ready-bys passed, or no plans) — the caller
 * then falls back to the ad-hoc loadpoint target.
 */
export function selectActivePlan(plans: Plan[], now: Date, tz: string): Plan | undefined {
  const { weekday, hour, minute } = localParts(now, tz)
  const nowMin = hour * 60 + minute
  const todayKey = DAY_KEYS[weekday]
  const candidates = plans.filter(
    (p) => p.enabled && p.days.includes(todayKey) && readyByMinutes(p.readyBy) > nowMin,
  )
  if (candidates.length === 0) return undefined
  return candidates.reduce((best, p) =>
    readyByMinutes(p.readyBy) < readyByMinutes(best.readyBy) ? p : best,
  )
}

/** The plan's ready-by as an absolute instant today (site-local). Call for the active plan only. */
export function planTargetTime(plan: Plan, now: Date, tz: string): Date {
  const [h, m] = plan.readyBy.split(':').map(Number)
  return new Date(now.getTime() + msUntilLocalTime(now, h, m, tz))
}

// A plan's target → charging value + display SoC now lives in ONE place: `resolveTarget` /
// `targetToSoc` in smart-charging/energy.ts (unit conversion + the energy ladder + resolvedSoc).
// The lifecycle builds a { unit, value } Target from the active plan (or the ad-hoc loadpoint
// target) and calls it; the API reuses targetToSoc for each plan's display %.
