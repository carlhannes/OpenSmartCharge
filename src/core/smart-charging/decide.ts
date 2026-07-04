import { plan } from '../planner.js'
import type { TariffSlot } from '../../sdk/tariff.js'

export interface DecideInputs {
  requiredKWh: number
  now: Date
  targetTime: Date
  /** Amps used to SIZE the plan — the current we'll actually apply (min(maxA, budget)). */
  planRateA: number
  phases: number
  /** Guaranteed non-empty by the price resolver. */
  priceSlots: TariffSlot[]
}

/**
 * Whether a smart-mode loadpoint should charge in the current slot. The extracted, testable
 * core of the old `computeShouldChargeNow`, but with no degradation branching — energy and
 * price are already resolved to guaranteed values before we get here.
 *
 * Sized at `planRateA` (the amps we'll actually apply) so a conservative budget grabs MORE
 * cheap slots — meeting the target early rather than under-charging.
 */
export function decideShouldCharge(i: DecideInputs): boolean {
  if (i.requiredKWh <= 0) return false // already at/above target — nothing to add
  const planned = plan({
    requiredKWh: i.requiredKWh,
    targetTime: i.targetTime,
    maxCurrentA: i.planRateA,
    phases: i.phases,
    priceSlots: i.priceSlots,
    now: i.now,
  })
  // `plan()` generates slots from the NEXT 15-min boundary onward, so when `now` sits inside the
  // current partial slot — i.e. almost always, since control ticks rarely land exactly on a
  // boundary — no planned slot covers `now`. Fall back to the IMMINENT slot's decision, NOT a
  // blanket "charge": otherwise smart mode would charge regardless of price for ~14 of every 15
  // minutes. planned[0] is the earliest (chronological) slot, so it's the right proxy for "now".
  const currentSlot = planned.find((s) => s.start <= i.now && s.end > i.now)
  return currentSlot?.shouldCharge ?? planned[0]?.shouldCharge ?? true
}

/**
 * Anti-chatter gate for the actuation step: only re-command the charger when the target moves
 * at least `deadbandA` from the last value we actually sent. The first command always writes.
 * Must compare against the last SENT value (not a suppressed candidate) so the allocator's
 * credit-back stays honest.
 */
export function shouldWrite(
  candidateA: number,
  lastCommandedA: number | undefined,
  deadbandA: number,
): boolean {
  if (lastCommandedA === undefined) return true
  return Math.abs(candidateA - lastCommandedA) >= deadbandA
}
