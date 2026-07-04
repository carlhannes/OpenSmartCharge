import { test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db.js'
import { recordHouseholdLoad, worstCaseLoadA, pruneHouseholdLoad } from './rollup.js'

function withDb(fn: (db: ReturnType<typeof openDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'osc-roll-'))
  const db = openDb(dir)
  try {
    fn(db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

// 00:00Z in summer = 02:00 CEST → Stockholm hour 2.
const at = (day: number) => new Date(`2026-07-0${day}T00:00:00Z`)

test('records the per-hour MAX; worstCaseLoadA spans the last N days for that hour-of-day', () => {
  withDb((db) => {
    recordHouseholdLoad(db, at(1), 10)
    recordHouseholdLoad(db, at(1), 5) // same day+hour → stays the max (10)
    recordHouseholdLoad(db, at(2), 20)
    recordHouseholdLoad(db, at(3), 15)
    recordHouseholdLoad(db, at(4), 5) // "today"

    // last 3 days (Jul 2–4) worst at hour 2 → 20
    expect(worstCaseLoadA(db, at(4), 3)).toBe(20)
    // last 2 days (Jul 3–4) → 15
    expect(worstCaseLoadA(db, at(4), 2)).toBe(15)
    // a different hour has no history → null
    expect(worstCaseLoadA(db, new Date('2026-07-04T10:00:00Z'), 3)).toBeNull()
  })
})

test('DST fall-back: the twice-occurring local hour collapses into one max row', () => {
  withDb((db) => {
    // 2026-10-25 fall-back: 02:30 CEST (00:30Z) and 02:30 CET (01:30Z) are both local hour 2.
    recordHouseholdLoad(db, new Date('2026-10-25T00:30:00Z'), 8)
    recordHouseholdLoad(db, new Date('2026-10-25T01:30:00Z'), 12)
    const rows = db
      .prepare(
        `SELECT date, hour, max_phase_a FROM household_load_hourly WHERE date = '2026-10-25' AND hour = 2`,
      )
      .all()
    expect(rows).toEqual([{ date: '2026-10-25', hour: 2, max_phase_a: 12 }])
  })
})

test('pruneHouseholdLoad drops rows older than keepDays', () => {
  withDb((db) => {
    recordHouseholdLoad(db, at(1), 10)
    recordHouseholdLoad(db, at(4), 20)
    pruneHouseholdLoad(db, at(4), 2) // keep Jul 3–4 → Jul 1 dropped
    expect(worstCaseLoadA(db, at(4), 30)).toBe(20) // only Jul 4 remains for hour 2
  })
})

test('ignores non-finite / negative samples', () => {
  withDb((db) => {
    recordHouseholdLoad(db, at(4), Number.NaN)
    recordHouseholdLoad(db, at(4), -5)
    expect(worstCaseLoadA(db, at(4), 3)).toBeNull()
  })
})
