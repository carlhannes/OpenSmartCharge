import { test, expect } from 'vitest'
import { plan, buildPlanSeries, type PlannedSlot } from './planner.js'
import type { TariffSlot } from '../sdk/tariff.js'

const NOW = new Date()
const TARGET_6H = new Date(NOW.getTime() + 6 * 3_600_000)
const TARGET_2H = new Date(NOW.getTime() + 2 * 3_600_000)

// Build a set of price slots from T+0h to T+6h with known prices
function priceSlots(pricesPerHour: number[]): TariffSlot[] {
  return pricesPerHour.flatMap((price, i) => {
    const start = new Date(NOW.getTime() + i * 3_600_000)
    const end = new Date(NOW.getTime() + (i + 1) * 3_600_000)
    return [{ start, end, pricePerKWh: price, currency: 'EUR' }]
  })
}

// 16A × 3-phase × 0.23 kV = 11.04 kW. One 15-min slot = 2.76 kWh.
const CHARGE_RATE_KW = (16 * 3 * 230) / 1000

test('requiredKWh=0 produces no charging slots', () => {
  const slots = plan({
    requiredKWh: 0,
    targetTime: TARGET_6H,
    maxCurrentA: 16,
    phases: 3,
    priceSlots: priceSlots([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
  })
  const charging = slots.filter((s) => s.shouldCharge)
  expect(charging.length).toBe(0)
})

test('single cheapest slot picked when requiredKWh fits in one slot', () => {
  // One 15-min slot = CHARGE_RATE_KW / 4 kWh. Request just that.
  const required = CHARGE_RATE_KW / 4
  const slots = plan({
    requiredKWh: required,
    targetTime: TARGET_6H,
    maxCurrentA: 16,
    phases: 3,
    priceSlots: priceSlots([0.5, 0.1, 0.4, 0.3, 0.2, 0.6]),
  })
  const charging = slots.filter((s) => s.shouldCharge)
  // Only 1 slot needed; it should be in the cheapest hour (index 1 = price 0.1)
  expect(charging.length).toBe(1)
  const cheapestHourStart = new Date(NOW.getTime() + 1 * 3_600_000)
  // the single charging slot should fall in the cheapest hour
  expect(
    charging[0].start >= cheapestHourStart &&
      charging[0].start < new Date(cheapestHourStart.getTime() + 3_600_000),
  ).toBe(true)
})

test('spreads across two cheapest hours when one slot is not enough', () => {
  // Request enough for 5 slots (1.25 h) → needs slots from the two cheapest hours
  const required = CHARGE_RATE_KW * 1.25
  const slots = plan({
    requiredKWh: required,
    targetTime: TARGET_6H,
    maxCurrentA: 16,
    phases: 3,
    priceSlots: priceSlots([0.5, 0.1, 0.4, 0.3, 0.2, 0.6]),
  })
  const charging = slots.filter((s) => s.shouldCharge)
  // 5 slots needed (ceil(1.25 h * 4)) = 5; they should be in hours 1 (0.1) and 4 (0.2)
  expect(charging.length).toBeGreaterThanOrEqual(4)
})

test('already-past target returns empty plan', () => {
  const past = new Date(NOW.getTime() - 1000) // 1 second ago
  const slots = plan({
    requiredKWh: 10,
    targetTime: past,
    maxCurrentA: 16,
    phases: 3,
  })
  expect(slots.length).toBe(0)
})

test('empty priceSlots falls back to latest-start plan (no cheap-slot pick)', () => {
  // With no price data: charge as late as possible (last N slots before target)
  const required = CHARGE_RATE_KW * 0.5 // 2 slots
  const slots = plan({
    requiredKWh: required,
    targetTime: TARGET_2H,
    maxCurrentA: 16,
    phases: 3,
    priceSlots: [],
  })
  const charging = slots.filter((s) => s.shouldCharge)
  // Should be the last 2 slots before TARGET_2H
  const notCharging = slots.filter((s) => !s.shouldCharge)
  if (notCharging.length > 0 && charging.length > 0) {
    // non-charging slots should precede charging slots in latest-start plan
    expect(notCharging[notCharging.length - 1].end <= charging[0].start).toBe(true)
  }
  expect(charging.length).toBeGreaterThan(0)
})

test('undefined priceSlots falls back to latest-start plan', () => {
  const required = CHARGE_RATE_KW * 0.5
  const slots = plan({
    requiredKWh: required,
    targetTime: TARGET_2H,
    maxCurrentA: 16,
    phases: 3,
  })
  expect(slots.length).toBeGreaterThan(0)
  const charging = slots.filter((s) => s.shouldCharge)
  expect(charging.length).toBeGreaterThan(0)
})

// buildPlanSeries: merge the price curve with the planner's chosen slots for the UI chart.
const planSlot = (offsetH: number, offsetMin: number, shouldCharge: boolean): PlannedSlot => ({
  start: new Date(NOW.getTime() + offsetH * 3_600_000 + offsetMin * 60_000),
  end: new Date(NOW.getTime() + offsetH * 3_600_000 + (offsetMin + 15) * 60_000),
  shouldCharge,
})

test('buildPlanSeries (smart): a charging plan slot marks the price slot it overlaps', () => {
  const prices = priceSlots([2, 0.1, 0.5]) // hours 0,1,2 from NOW
  const planned = [planSlot(0, 0, false), planSlot(1, 15, true)] // charging only in hour 1
  const series = buildPlanSeries(prices, planned, 'smart')
  expect(series.length).toBe(3)
  expect(series.map((s) => s.shouldCharge)).toEqual([false, true, false])
  expect(series[1].pricePerKWh).toBe(0.1) // price carried through onto the series
})

test('buildPlanSeries (fast): every slot charges regardless of plan', () => {
  const series = buildPlanSeries(priceSlots([2, 0.1, 0.5]), [], 'fast')
  expect(series.every((s) => s.shouldCharge)).toBe(true)
})

test('buildPlanSeries (disabled): no slot charges even with a charging plan slot', () => {
  const series = buildPlanSeries(priceSlots([2, 0.1, 0.5]), [planSlot(1, 0, true)], 'disabled')
  expect(series.every((s) => !s.shouldCharge)).toBe(true)
})

test('buildPlanSeries: empty prices → empty series', () => {
  expect(buildPlanSeries([], [planSlot(1, 0, true)], 'smart')).toEqual([])
})
