import type { TariffSlot } from '../sdk/tariff.js'
import type { ChargeMode } from './config.js'
import { chargeRateKW } from '../sdk/electrical.js'

export interface PlannerInput {
  requiredKWh: number
  targetTime: Date
  maxCurrentA: number
  phases: number
  priceSlots?: TariffSlot[]
  /** Current instant; defaults to `new Date()`. Injectable so callers/tests are deterministic. */
  now?: Date
}

export interface PlannedSlot {
  start: Date
  end: Date
  shouldCharge: boolean
}

// Returns a 15-min slot schedule between now and targetTime.
// With price data: picks the cheapest slots that deliver the required energy.
// Without price data: charges as late as possible (latest start that still finishes on time).
export function plan(input: PlannerInput): PlannedSlot[] {
  const { requiredKWh, targetTime, maxCurrentA, phases, priceSlots } = input
  const now = input.now ?? new Date()

  const rateKW = chargeRateKW(maxCurrentA, phases)
  const requiredSlots = Math.ceil((requiredKWh / rateKW) * 4) // 4 slots per hour

  const allSlots = generateSlots(now, targetTime)
  if (allSlots.length === 0) return []

  const slotsNeeded = Math.min(requiredSlots, allSlots.length)

  if (!priceSlots || priceSlots.length === 0) {
    return latestStartPlan(allSlots, slotsNeeded)
  }

  return cheapestSlotsPlan(allSlots, slotsNeeded, priceSlots)
}

function latestStartPlan(slots: { start: Date; end: Date }[], slotsNeeded: number): PlannedSlot[] {
  const startIndex = slots.length - slotsNeeded
  return slots.map((slot, i) => ({ ...slot, shouldCharge: i >= startIndex }))
}

function cheapestSlotsPlan(
  slots: { start: Date; end: Date }[],
  slotsNeeded: number,
  priceSlots: TariffSlot[],
): PlannedSlot[] {
  const withPrices = slots.map((slot) => {
    const match = priceSlots.find((p) => p.start <= slot.start && p.end > slot.start)
    return { ...slot, pricePerKWh: match?.pricePerKWh ?? Infinity }
  })

  const sorted = [...withPrices].sort((a, b) => a.pricePerKWh - b.pricePerKWh)
  const cheapestStarts = new Set(sorted.slice(0, slotsNeeded).map((s) => s.start.toISOString()))

  return withPrices.map((slot) => ({
    start: slot.start,
    end: slot.end,
    shouldCharge: cheapestStarts.has(slot.start.toISOString()),
  }))
}

export interface PlanSeriesSlot {
  start: Date
  end: Date
  pricePerKWh: number
  shouldCharge: boolean
}

/**
 * Merge a price series with the planner's chosen slots into one time-aligned series for the UI
 * "price & plan" chart. One entry per price slot; `shouldCharge` is:
 *   - fast     → always (charges whenever it can),
 *   - disabled → never,
 *   - smart    → a chosen plan slot OVERLAPS this price slot.
 * Plan slots are 15-min while prices are typically hourly, but equal-priced sub-slots are always
 * selected together by `plan()`, so the roll-up onto the price grid is lossless.
 */
export function buildPlanSeries(
  prices: TariffSlot[],
  plannedSlots: PlannedSlot[],
  mode: ChargeMode,
): PlanSeriesSlot[] {
  const charging = plannedSlots.filter((s) => s.shouldCharge)
  return prices.map((p) => ({
    start: p.start,
    end: p.end,
    pricePerKWh: p.pricePerKWh,
    shouldCharge:
      mode === 'fast'
        ? true
        : mode === 'disabled'
          ? false
          : charging.some((s) => s.start < p.end && s.end > p.start),
  }))
}

const SLOT_MS = 15 * 60_000

// Epoch arithmetic, never local-time setters: on a host with DST, stepping with setMinutes() makes
// the repeated autumn hour one 75-min slot and drops four. Every UTC offset in use is a multiple of
// 15 min, so a UTC quarter-hour boundary is a local one too. Rounds UP (a `from` past a boundary by
// even 1 ms starts at the next one, never in the past).
function generateSlots(from: Date, to: Date): { start: Date; end: Date }[] {
  const slots: { start: Date; end: Date }[] = []
  for (let t = Math.ceil(from.getTime() / SLOT_MS) * SLOT_MS; t < to.getTime(); t += SLOT_MS) {
    slots.push({ start: new Date(t), end: new Date(t + SLOT_MS) })
  }
  return slots
}
