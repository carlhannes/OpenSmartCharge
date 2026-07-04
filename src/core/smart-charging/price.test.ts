import { test, expect } from 'vitest'
import { resolvePriceCurve } from './price.js'
import { plan } from '../planner.js'
import type { TariffSlot } from '../../sdk/tariff.js'

const NIGHT = { startHour: 23, endHour: 5 }

test('live-tariff rung: live prices pass through unchanged', () => {
  const live: TariffSlot[] = [
    {
      start: new Date('2026-07-04T10:00:00Z'),
      end: new Date('2026-07-04T11:00:00Z'),
      pricePerKWh: 0.5,
      currency: 'SEK',
    },
  ]
  const r = resolvePriceCurve({
    livePrices: live,
    now: new Date('2026-07-04T10:00:00Z'),
    targetTime: new Date('2026-07-04T12:00:00Z'),
    nightWindow: NIGHT,
  })
  expect(r).toMatchObject({ source: 'live-tariff', degraded: false })
  expect(r.value).toBe(live)
})

test('static-night rung: contiguous curve covering the window, night cheaper than day (never equal)', () => {
  const now = new Date('2026-07-04T19:00:00Z') // 21:00 CEST
  const targetTime = new Date('2026-07-05T05:00:00Z') // 07:00 CEST
  const r = resolvePriceCurve({ now, targetTime, nightWindow: NIGHT })
  expect(r.source).toBe('static-night')
  expect(r.value[0].start.getTime()).toBeLessThanOrEqual(now.getTime()) // starts at/before now
  expect(r.value[r.value.length - 1].end.getTime()).toBeGreaterThanOrEqual(targetTime.getTime())
  // exactly two distinct prices (night vs day) — an all-equal curve would charge ASAP, a bug.
  expect(new Set(r.value.map((s) => s.pricePerKWh)).size).toBe(2)
})

test('static-night curve makes the planner defer to the night, not charge ASAP', () => {
  const now = new Date('2026-07-04T19:00:00Z') // 21:00 CEST (evening = expensive)
  const targetTime = new Date('2026-07-05T05:00:00Z') // 07:00 CEST
  const { value: priceSlots } = resolvePriceCurve({ now, targetTime, nightWindow: NIGHT })
  const planned = plan({ requiredKWh: 5, targetTime, maxCurrentA: 16, phases: 1, priceSlots, now })
  const charging = planned.filter((s) => s.shouldCharge)
  expect(charging.length).toBeGreaterThan(0)
  // First charging slot is NOT the first (evening) slot — the guard against the all-equal ASAP trap.
  expect(charging[0].start.getTime()).toBeGreaterThan(planned[0].start.getTime())
})

test('historical-avg rung: builds an hourly synthetic curve from the by-hour map', () => {
  const avg = new Map<number, number>([
    [2, 0.1],
    [3, 0.1],
  ])
  const r = resolvePriceCurve({
    historicalAvgByHour: avg,
    now: new Date('2026-07-04T19:00:00Z'),
    targetTime: new Date('2026-07-05T05:00:00Z'),
    nightWindow: NIGHT,
  })
  expect(r).toMatchObject({ source: 'historical-avg', degraded: true })
  expect(r.value.length).toBeGreaterThan(0)
})
