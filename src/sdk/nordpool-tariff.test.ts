import { test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../core/db.js'
import type { TariffSlot } from './tariff.js'
import {
  upsertSlots,
  getSlots,
  latestSlotEnd,
  computeTariffHealth,
  hasTomorrow,
  nextDelay,
  type SchedulerState,
} from './nordpool-tariff.js'

function withDb(fn: (db: ReturnType<typeof openDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'osc-np-'))
  const db = openDb(dir)
  try {
    fn(db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const slot = (startIso: string, endIso: string, price: number): TariffSlot => ({
  start: new Date(startIso),
  end: new Date(endIso),
  pricePerKWh: price,
  currency: 'SEK',
})

test('upsertSlots/getSlots round-trip; getSlots windows by slot_start; upsert replaces', () => {
  withDb((db) => {
    upsertSlots(db, 'SE4', [
      slot('2026-07-04T00:00:00Z', '2026-07-04T01:00:00Z', 0.5),
      slot('2026-07-04T01:00:00Z', '2026-07-04T02:00:00Z', 0.6),
      slot('2026-07-04T02:00:00Z', '2026-07-04T03:00:00Z', 0.7),
    ])
    // Window read excludes slots starting outside [from, to).
    const mid = getSlots(db, 'SE4', new Date('2026-07-04T01:00:00Z'), new Date('2026-07-04T02:00:00Z'))
    expect(mid.map((s) => s.pricePerKWh)).toEqual([0.6])
    // Re-upsert same slot_start overwrites (INSERT OR REPLACE).
    upsertSlots(db, 'SE4', [slot('2026-07-04T01:00:00Z', '2026-07-04T02:00:00Z', 0.99)])
    const again = getSlots(db, 'SE4', new Date('2026-07-04T01:00:00Z'), new Date('2026-07-04T02:00:00Z'))
    expect(again[0].pricePerKWh).toBe(0.99)
    expect(latestSlotEnd(db, 'SE4')?.toISOString()).toBe('2026-07-04T03:00:00.000Z')
    // Zones are isolated.
    expect(getSlots(db, 'SE1', new Date('2026-07-04T00:00:00Z'), new Date('2026-07-05T00:00:00Z'))).toEqual([])
  })
})

test('computeTariffHealth: unavailable when empty/expired, ok/degraded around publish window', () => {
  withDb((db) => {
    const now = new Date('2026-07-04T10:00:00Z') // 12:00 Stockholm, before 13:15
    expect(computeTariffHealth(db, 'SE4', now)).toBe('unavailable') // no data

    // Today's data only (ends tonight) → before publish window this is ok…
    upsertSlots(db, 'SE4', [slot('2026-07-04T10:00:00Z', '2026-07-04T22:00:00Z', 0.5)])
    expect(hasTomorrow(db, 'SE4', now)).toBe(false)
    expect(computeTariffHealth(db, 'SE4', now)).toBe('ok')

    // …but AFTER the publish window with no tomorrow → degraded.
    const afterPublish = new Date('2026-07-04T12:00:00Z') // 14:00 Stockholm
    expect(computeTariffHealth(db, 'SE4', afterPublish)).toBe('degraded')

    // Tomorrow present (ends >20h out) → ok even after publish window.
    upsertSlots(db, 'SE4', [slot('2026-07-05T00:00:00Z', '2026-07-06T00:00:00Z', 0.4)])
    expect(hasTomorrow(db, 'SE4', afterPublish)).toBe(true)
    expect(computeTariffHealth(db, 'SE4', afterPublish)).toBe('ok')

    // All data in the past → unavailable.
    expect(computeTariffHealth(db, 'SE4', new Date('2026-07-10T00:00:00Z'))).toBe('unavailable')
  })
})

test('nextDelay: next-day when tomorrow cached, wait-for-window before 13:15, retry after', () => {
  const s: SchedulerState = { consecutiveFailures: 0 }
  expect(nextDelay(s, true, new Date('2026-07-04T09:00:00Z')).reason).toBe('next-day')
  expect(nextDelay(s, false, new Date('2026-07-04T09:00:00Z')).reason).toBe('wait-for-window')
  // After publish (14:00 Stockholm), no tomorrow, first failure → +30 min retry.
  const retry = nextDelay(s, false, new Date('2026-07-04T12:00:00Z'))
  expect(retry.reason).toBe('retry')
  expect(retry.delayMs).toBe(30 * 60_000)
  // Late enough that a backed-off retry would cross midnight → defer to next-day.
  const late = nextDelay({ consecutiveFailures: 6 }, false, new Date('2026-07-04T21:50:00Z'))
  expect(late.reason).toBe('next-day')
})
