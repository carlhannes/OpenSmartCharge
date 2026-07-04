import type { TariffSlot } from '../../sdk/tariff.js'
import { stockholmHour, isNight } from '../../sdk/stockholm-time.js'
import type { Resolved, PriceRung, NightWindow } from './types.js'

export interface PriceInputs {
  /** Live day-ahead slots from the tariff module; empty/undefined → fall back. */
  livePrices?: TariffSlot[]
  /** Historical average price keyed by Stockholm hour-of-day (0–23). */
  historicalAvgByHour?: Map<number, number>
  now: Date
  targetTime: Date
  nightWindow: NightWindow
  /** Synthetic-curve prices (relative ordering only). night < day so night wins. */
  nightPrice?: number
  dayPrice?: number
}

/**
 * Resolve a price curve covering [now, targetTime], degrading:
 *  1. live-tariff     — real day-ahead prices
 *  2. historical-avg  — synthetic hourly curve from the last-N-day average per hour-of-day
 *  3. static-night    — synthetic hourly curve: cheap in the night window, expensive by day
 *
 * The result is ALWAYS a non-empty curve, so the planner never has to branch on "no prices"
 * (which would make it charge as late as possible instead of at the cheapest hours).
 *
 * The synthetic curves use genuinely lower night prices — NOT equal prices. An all-equal
 * curve makes the planner charge ASAP; distinct night/day prices make it prefer the night.
 */
export function resolvePriceCurve(i: PriceInputs): Resolved<TariffSlot[], PriceRung> {
  if (i.livePrices && i.livePrices.length > 0) {
    return { value: i.livePrices, source: 'live-tariff', degraded: false }
  }

  const nightPrice = i.nightPrice ?? 1
  const dayPrice = i.dayPrice ?? 2

  if (i.historicalAvgByHour && i.historicalAvgByHour.size > 0) {
    const value = buildHourlyCurve(i.now, i.targetTime, (start) => {
      // Missing hour in the history → treat as expensive so it's only used if unavoidable.
      return i.historicalAvgByHour!.get(stockholmHour(start)) ?? dayPrice
    })
    return { value, source: 'historical-avg', degraded: true }
  }

  const value = buildHourlyCurve(i.now, i.targetTime, (start) =>
    isNight(start, i.nightWindow.startHour, i.nightWindow.endHour) ? nightPrice : dayPrice,
  )
  return { value, source: 'static-night', degraded: true }
}

// Contiguous 1-hour slots from the top of `now`'s hour up to `to`, each priced by `priceAt`.
// Starting at the top of the hour guarantees the planner's 15-min sub-slots (which begin at
// the next quarter-hour ≥ now) are all covered by a containing price slot.
function buildHourlyCurve(now: Date, to: Date, priceAt: (start: Date) => number): TariffSlot[] {
  const slots: TariffSlot[] = []
  const cursor = new Date(now)
  cursor.setMinutes(0, 0, 0)
  while (cursor.getTime() < to.getTime()) {
    const end = new Date(cursor.getTime() + 3600_000)
    slots.push({ start: new Date(cursor), end, pricePerKWh: priceAt(cursor), currency: 'SEK' })
    cursor.setTime(end.getTime())
  }
  return slots
}
