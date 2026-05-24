import type { TariffSlot } from '../sdk/tariff.js'

export interface PlannerInput {
  requiredKWh: number
  targetTime: Date
  maxCurrentA: number
  phases: number
  priceSlots?: TariffSlot[]
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
  const now = new Date()

  const chargeRateKW = (maxCurrentA * phases * 230) / 1000
  const requiredSlots = Math.ceil((requiredKWh / chargeRateKW) * 4) // 4 slots per hour

  const allSlots = generateSlots(now, targetTime)
  if (allSlots.length === 0) return []

  const slotsNeeded = Math.min(requiredSlots, allSlots.length)

  if (!priceSlots || priceSlots.length === 0) {
    return latestStartPlan(allSlots, slotsNeeded)
  }

  return cheapestSlotsPlan(allSlots, slotsNeeded, priceSlots)
}

function latestStartPlan(
  slots: { start: Date; end: Date }[],
  slotsNeeded: number,
): PlannedSlot[] {
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
  const cheapestStarts = new Set(
    sorted.slice(0, slotsNeeded).map((s) => s.start.toISOString()),
  )

  return withPrices.map((slot) => ({
    start: slot.start,
    end: slot.end,
    shouldCharge: cheapestStarts.has(slot.start.toISOString()),
  }))
}

function generateSlots(from: Date, to: Date): { start: Date; end: Date }[] {
  const slots: { start: Date; end: Date }[] = []
  const cursor = new Date(from)
  // Round up to next 15-min boundary.
  // When minutes % 15 === 0 but seconds/ms > 0 we must still round UP —
  // otherwise cursor moves backwards relative to `from` and generates stale slots.
  const rem = cursor.getMinutes() % 15
  const sub = cursor.getSeconds() * 1000 + cursor.getMilliseconds()
  if (rem !== 0 || sub > 0) cursor.setMinutes(cursor.getMinutes() + (15 - rem), 0, 0)

  while (cursor < to) {
    const start = new Date(cursor)
    cursor.setMinutes(cursor.getMinutes() + 15)
    slots.push({ start, end: new Date(cursor) })
  }
  return slots
}
