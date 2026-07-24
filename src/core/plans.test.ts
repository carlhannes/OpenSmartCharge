import { test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from './db.js'
import { localWeekday } from '../sdk/local-time.js'
import {
  DAY_KEYS,
  daysToMask,
  maskToDays,
  createPlan,
  listPlans,
  getPlan,
  updatePlan,
  deletePlan,
  selectActivePlan,
  planApplies,
  type Plan,
  type DayKey,
} from './plans.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'osc-plans-'))
  dirs.push(dir)
  return openDb(dir)
}

// ── mask ──────────────────────────────────────────────────────────────────────

test('daysToMask / maskToDays round-trip and order-normalize', () => {
  expect(maskToDays(daysToMask(['mon', 'wed', 'fri']))).toEqual(['mon', 'wed', 'fri'])
  expect(maskToDays(daysToMask(['sun', 'mon']))).toEqual(['mon', 'sun']) // normalized to DAY_KEYS order
  expect(daysToMask([])).toBe(0)
  expect(maskToDays(daysToMask(DAY_KEYS as DayKey[]))).toEqual([...DAY_KEYS])
})

// ── resolution (pure) ───────────────────────────────────────────────────────

const TZ = 'UTC' // keeps local wall-clock == the ISO instant, so the test is easy to reason about
const NOW = new Date('2026-07-06T08:00:00Z') // 08:00 local (UTC)
const TODAY = DAY_KEYS[localWeekday(NOW, TZ)]
const OTHER = DAY_KEYS[(localWeekday(NOW, TZ) + 1) % 7]

let nextId = 1
function mkPlan(over: Partial<Plan>): Plan {
  return {
    id: nextId++,
    loadpointName: 'lp',
    days: [TODAY],
    readyBy: '09:00',
    target: 80,
    unit: 'pct',
    enabled: true,
    vehicles: [],
    pauseOnTarget: true,
    ...over,
  }
}

test('selectActivePlan: earliest still-upcoming ready-by among today’s enabled plans wins', () => {
  const a = mkPlan({ readyBy: '09:00' }) // upcoming
  const later = mkPlan({ readyBy: '10:00' }) // upcoming but later
  const passed = mkPlan({ readyBy: '07:00' }) // already past today
  const notToday = mkPlan({ days: [OTHER], readyBy: '08:30' })
  const disabled = mkPlan({ readyBy: '08:30', enabled: false })
  const active = selectActivePlan([later, passed, notToday, disabled, a], NOW, TZ, null)
  expect(active?.id).toBe(a.id)
})

test('selectActivePlan returns undefined when no plan qualifies today', () => {
  expect(selectActivePlan([], NOW, TZ, null)).toBeUndefined()
  expect(selectActivePlan([mkPlan({ days: [OTHER] })], NOW, TZ, null)).toBeUndefined() // wrong day
  expect(selectActivePlan([mkPlan({ readyBy: '06:00' })], NOW, TZ, null)).toBeUndefined() // all passed
  expect(selectActivePlan([mkPlan({ enabled: false })], NOW, TZ, null)).toBeUndefined() // disabled
})

test('planApplies + selectActivePlan filter by the active vehicle', () => {
  expect(planApplies(mkPlan({ vehicles: [] }), 'enyaq')).toBe(true) // empty = any (catch-all)
  expect(planApplies(mkPlan({ vehicles: [] }), null)).toBe(true) // incl. guest
  expect(planApplies(mkPlan({ vehicles: ['enyaq'] }), 'enyaq')).toBe(true)
  expect(planApplies(mkPlan({ vehicles: ['enyaq'] }), 'opel')).toBe(false)
  expect(planApplies(mkPlan({ vehicles: ['guest'] }), null)).toBe(true) // null active = guest
  expect(planApplies(mkPlan({ vehicles: ['enyaq'] }), null)).toBe(false)
  // Selection only considers plans that apply to the active vehicle.
  const enyaqPlan = mkPlan({ readyBy: '09:00', vehicles: ['enyaq'] })
  const guestPlan = mkPlan({ readyBy: '08:30', vehicles: ['guest'] })
  expect(selectActivePlan([enyaqPlan, guestPlan], NOW, TZ, 'enyaq')?.id).toBe(enyaqPlan.id)
  expect(selectActivePlan([enyaqPlan, guestPlan], NOW, TZ, null)?.id).toBe(guestPlan.id)
})

// Target conversion (pct/km/kwh → SoC%, resolveTarget) moved to smart-charging/energy.test.ts —
// it now lives with the resolver that owns it.

// ── persistence CRUD ──────────────────────────────────────────────────────────

test('CRUD: create → list → get → update (partial) → delete', () => {
  const db = freshDb()
  const created = createPlan(db, 'garage', {
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    readyBy: '07:00',
    target: 80,
    unit: 'pct',
  })
  expect(created.id).toBeGreaterThan(0)
  expect(created.enabled).toBe(true) // default
  expect(listPlans(db, 'garage')).toHaveLength(1)
  expect(listPlans(db, 'other')).toHaveLength(0) // scoped by loadpoint

  // partial update: only readyBy + enabled; days/target/unit untouched.
  const updated = updatePlan(db, created.id, { readyBy: '08:30', enabled: false })
  expect(updated).toMatchObject({ readyBy: '08:30', enabled: false, target: 80, unit: 'pct' })
  expect(updated?.days).toEqual(['mon', 'tue', 'wed', 'thu', 'fri'])

  expect(deletePlan(db, created.id)).toBe(true)
  expect(getPlan(db, created.id)).toBeUndefined()
  expect(deletePlan(db, created.id)).toBe(false) // already gone
})
