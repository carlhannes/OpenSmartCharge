import { test, expect } from 'vitest'
import { decideShouldCharge, shouldWrite } from './decide.js'
import type { TariffSlot } from '../../sdk/tariff.js'

const hour = (h: number, price: number): TariffSlot => ({
  start: new Date(`2026-07-04T${String(h).padStart(2, '0')}:00:00Z`),
  end: new Date(`2026-07-04T${String(h + 1).padStart(2, '0')}:00:00Z`),
  pricePerKWh: price,
  currency: 'SEK',
})

test('requiredKWh <= 0 → never charge (already at target)', () => {
  expect(
    decideShouldCharge({
      requiredKWh: 0,
      now: new Date('2026-07-04T22:00:00Z'),
      targetTime: new Date('2026-07-05T06:00:00Z'),
      planRateA: 16,
      phases: 3,
      priceSlots: [],
    }),
  ).toBe(false)
})

test('charges now when the current slot is among the cheapest needed', () => {
  const now = new Date('2026-07-04T22:00:00Z')
  const targetTime = new Date('2026-07-04T23:00:00Z')
  // Large requirement + a 1h window → all slots needed → current slot charges.
  expect(
    decideShouldCharge({
      requiredKWh: 100,
      now,
      targetTime,
      planRateA: 16,
      phases: 3,
      priceSlots: [hour(22, 0.1)],
    }),
  ).toBe(true)
})

test('defers when the current slot is expensive and a cheaper later slot suffices', () => {
  const now = new Date('2026-07-04T18:00:00Z')
  const targetTime = new Date('2026-07-04T22:00:00Z')
  const priceSlots = [hour(18, 2), hour(19, 2), hour(20, 2), hour(21, 0.1)]
  // Only ~15 min needed → planner picks the cheap 21:00 slot, so 18:00 (now) must not charge.
  expect(
    decideShouldCharge({ requiredKWh: 2, now, targetTime, planRateA: 16, phases: 3, priceSlots }),
  ).toBe(false)
})

test('defers even when now is OFF a 15-min boundary (regression: current partial slot)', () => {
  // `now` mid-slot (18:07:23) → plan()'s first slot is 18:15, so no slot covers `now`. The old code
  // fell through to a blanket "charge"; it must instead mirror the imminent slot and defer to 21:00.
  const now = new Date('2026-07-04T18:07:23.456Z')
  const targetTime = new Date('2026-07-04T22:00:00Z')
  const priceSlots = [hour(18, 2), hour(19, 2), hour(20, 2), hour(21, 0.1)]
  expect(
    decideShouldCharge({ requiredKWh: 2, now, targetTime, planRateA: 16, phases: 3, priceSlots }),
  ).toBe(false)
})

test('charges when now is off-boundary and the imminent slot IS among the cheapest', () => {
  // Same off-boundary timing, but now the current/imminent hour is the cheap one → charge.
  const now = new Date('2026-07-04T21:07:23.456Z')
  const targetTime = new Date('2026-07-04T23:00:00Z')
  const priceSlots = [hour(21, 0.1), hour(22, 2)]
  expect(
    decideShouldCharge({ requiredKWh: 2, now, targetTime, planRateA: 16, phases: 3, priceSlots }),
  ).toBe(true)
})

test('shouldWrite: first write always; then only when |delta| ≥ deadband', () => {
  expect(shouldWrite(10, undefined, 1)).toBe(true)
  expect(shouldWrite(10, 10, 1)).toBe(false)
  expect(shouldWrite(10.5, 10, 1)).toBe(false)
  expect(shouldWrite(11, 10, 1)).toBe(true)
  expect(shouldWrite(0, 6, 1)).toBe(true) // stop (6→0) always exceeds the deadband
})
