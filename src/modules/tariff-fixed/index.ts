import { registerTariff } from '../../sdk/registry-api.js'
import type { TariffSlot } from '../../sdk/tariff.js'

/**
 * Contiguous hourly slots spanning [from, to], all at the same price. Aligned to the hour that
 * contains `from` so the first slot covers `now`, and extended until the last slot reaches `to`.
 */
export function generateFlatSlots(
  from: Date,
  to: Date,
  pricePerKWh: number,
  currency: string,
): TariffSlot[] {
  const slots: TariffSlot[] = []
  const cursor = new Date(from)
  cursor.setMinutes(0, 0, 0) // align to the top of the hour containing `from`
  while (cursor < to) {
    const start = new Date(cursor)
    cursor.setHours(cursor.getHours() + 1)
    slots.push({ start, end: new Date(cursor), pricePerKWh, currency })
  }
  return slots
}

/**
 * Flat-rate tariff: every slot costs the same. For users on a fixed-price electricity contract (no
 * day-ahead spot pricing). Smart mode still plans against the target/deadline, but because all slots
 * are equal-priced the cheapest-slots planner charges as EARLY as possible (soonest slots first) —
 * which also makes it a deterministic price source for tests. Needs no network, so health is always
 * `ok` and there is nothing to start/stop.
 */
registerTariff({
  type: 'fixed',
  create(cfg) {
    const c = cfg as { name: string; pricePerKWh?: number; currency?: string }
    const pricePerKWh = typeof c.pricePerKWh === 'number' ? c.pricePerKWh : 0
    const currency = typeof c.currency === 'string' ? c.currency : 'SEK'
    return {
      id: c.name,
      async start() {},
      async stop() {},
      health() {
        return 'ok'
      },
      async prices(from, to) {
        return generateFlatSlots(from, to, pricePerKWh, currency)
      },
    }
  },
})
