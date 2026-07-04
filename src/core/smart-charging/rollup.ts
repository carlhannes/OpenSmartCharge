import type { DatabaseSync } from 'node:sqlite'
import { stockholmDateKey, stockholmHour } from '../../sdk/stockholm-time.js'

// Household-load history for the "worst-case current over the last N days" charging fallback.
// Stored as an hourly MAX rollup (one row per Stockholm day+hour) rather than raw samples:
// bounded at 24 rows/day regardless of meter cadence, a single MAX query, and DST-safe (a
// repeated local hour collapses via the max() upsert).

/** Fold one household-load sample (max phase current, A) into the hourly-max rollup. */
export function recordHouseholdLoad(db: DatabaseSync, at: Date, maxPhaseA: number): void {
  if (!Number.isFinite(maxPhaseA) || maxPhaseA < 0) return
  db.prepare(
    `INSERT INTO household_load_hourly (date, hour, max_phase_a) VALUES (?, ?, ?)
     ON CONFLICT(date, hour) DO UPDATE SET max_phase_a = MAX(max_phase_a, excluded.max_phase_a)`,
  ).run(stockholmDateKey(at), stockholmHour(at), maxPhaseA)
}

/**
 * Worst-case (max) household load observed in `at`'s Stockholm hour-of-day across the last
 * `historicalDays` calendar days (inclusive of `at`'s day). Null when there's no history for
 * that hour yet — the caller then falls through to the static rung.
 */
export function worstCaseLoadA(db: DatabaseSync, at: Date, historicalDays: number): number | null {
  const earliest = new Date(at.getTime() - (historicalDays - 1) * 24 * 3600_000)
  const row = db
    .prepare(
      `SELECT MAX(max_phase_a) AS worst FROM household_load_hourly WHERE hour = ? AND date >= ?`,
    )
    .get(stockholmHour(at), stockholmDateKey(earliest)) as { worst: number | null }
  return row.worst ?? null
}

/**
 * Drop rollup rows older than `keepDays` — pure housekeeping to cap table growth. Correctness
 * does not depend on it (worstCaseLoadA is date-bounded), so call it infrequently (on day
 * rollover), never on the hot per-sample path.
 */
export function pruneHouseholdLoad(db: DatabaseSync, now: Date, keepDays: number): void {
  const cutoff = new Date(now.getTime() - keepDays * 24 * 3600_000)
  db.prepare(`DELETE FROM household_load_hourly WHERE date < ?`).run(stockholmDateKey(cutoff))
}
