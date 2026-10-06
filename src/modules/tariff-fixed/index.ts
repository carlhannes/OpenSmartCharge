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
  const HOUR_MS = 3_600_000
  const slots: TariffSlot[] = []
  // Epoch steps, not local setHours(): on a DST host the repeated autumn hour would otherwise become
  // one 2-hour slot. Aligned to the (UTC) hour containing `from`, so the first slot covers `now`.
  for (let t = Math.floor(from.getTime() / HOUR_MS) * HOUR_MS; t < to.getTime(); t += HOUR_MS) {
    slots.push({ start: new Date(t), end: new Date(t + HOUR_MS), pricePerKWh, currency })
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
