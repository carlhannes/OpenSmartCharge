import { test, expect } from 'vitest'
import { resolveEnergyTarget, targetToSoc, availableUnits, resolveTarget } from './energy.js'

const base = { sessionEnergyKWh: 0, hoursUntilTarget: 8, maxCurrentA: 16, phases: 3 }

test('soc-capacity rung: (target − soc)% × capacity / efficiency', () => {
  const r = resolveEnergyTarget({
    ...base,
    estimatedSocPct: 50,
    targetSocPct: 80,
    batteryCapacityKWh: 60,
  })
  expect(r.source).toBe('soc-capacity')
  expect(r.degraded).toBe(false)
  expect(r.value).toBeCloseTo((0.3 * 60) / 0.92, 3) // ≈ 19.565
})

test('soc-capacity rung: already at/above target → 0', () => {
  const r = resolveEnergyTarget({
    ...base,
    estimatedSocPct: 85,
    targetSocPct: 80,
    batteryCapacityKWh: 60,
  })
  expect(r.value).toBe(0)
  expect(r.source).toBe('soc-capacity')
})

test('target-kwh rung: fixed target minus session energy, converging to 0', () => {
  expect(resolveEnergyTarget({ ...base, targetKWh: 40 })).toMatchObject({
    value: 40,
    source: 'target-kwh',
    degraded: true,
  })
  expect(resolveEnergyTarget({ ...base, targetKWh: 40, sessionEnergyKWh: 15 }).value).toBe(25)
  expect(resolveEnergyTarget({ ...base, targetKWh: 40, sessionEnergyKWh: 50 }).value).toBe(0)
})

test('duty-cycle rung: hoursUntilTarget × rate × 0.4 when no vehicle info', () => {
  const r = resolveEnergyTarget({ ...base, hoursUntilTarget: 10 })
  expect(r.source).toBe('duty-cycle')
  expect(r.degraded).toBe(true)
  expect(r.value).toBeCloseTo(10 * ((16 * 3 * 230) / 1000) * 0.4, 2) // ≈ 44.16
})

test('SoC rung needs soc AND capacity AND targetSoc; otherwise falls through', () => {
  // No targetSoc but a fixed target present → target-kwh.
  const r = resolveEnergyTarget({
    ...base,
    estimatedSocPct: 50,
    batteryCapacityKWh: 60,
    targetKWh: 30,
  })
  expect(r.source).toBe('target-kwh')
})

// ── targetToSoc: the single unit→SoC% conversion ──────────────────────────────

test('targetToSoc: pct passes through, kwh is not a SoC state, km uses the range/soc ratio', () => {
  expect(targetToSoc({ unit: 'pct', value: 80 }, {})).toBe(80)
  expect(targetToSoc({ unit: 'kwh', value: 40 }, { capacity: 60 })).toBeNull()
  // 300 km at 60% → 5 km/% → 350 km ⇒ 70%.
  expect(targetToSoc({ unit: 'km', value: 350 }, { range: 300, soc: 60 })).toBe(70)
  expect(targetToSoc({ unit: 'km', value: 400 }, { range: 100, soc: 50 })).toBe(100) // clamps at 100
})

test('targetToSoc: km with no usable reading → null (caller degrades to duty-cycle)', () => {
  expect(targetToSoc({ unit: 'km', value: 350 }, {})).toBeNull()
  expect(targetToSoc({ unit: 'km', value: 350 }, { range: 300, soc: 0 })).toBeNull()
  expect(targetToSoc({ unit: 'km', value: 350 }, { range: 0, soc: 60 })).toBeNull()
})

// ── availableUnits: which target units a loadpoint's data can back ─────────────

test('availableUnits: kwh always; pct needs soc+capacity; km also needs range', () => {
  expect(availableUnits({ soc: 55, range: 300, capacity: 60 })).toEqual(['pct', 'km', 'kwh'])
  expect(availableUnits({ soc: 55, capacity: 60 })).toEqual(['pct', 'kwh']) // no range → no km
  expect(availableUnits({ soc: 55 })).toEqual(['kwh']) // no capacity → only kwh
  expect(availableUnits({})).toEqual(['kwh']) // no car at all
})

// ── resolveTarget: one entry → requiredKWh (via the ladder) + resolvedSoc ──────

test('resolveTarget: pct → soc-capacity kWh + resolvedSoc = the target', () => {
  const r = resolveTarget(
    { unit: 'pct', value: 80 },
    { ...base, estimatedSocPct: 50, capacity: 60 },
  )
  expect(r.source).toBe('soc-capacity')
  expect(r.resolvedSoc).toBe(80)
  expect(r.requiredKWh).toBeCloseTo((0.3 * 60) / 0.92, 3)
})

test('resolveTarget: km resolves via the ratio, then sizes kWh from the resolved SoC', () => {
  // 300 km at 60% → 5 km/% → 350 km ⇒ 70% target; estimated 60% now → 10% × 60 kWh / 0.92.
  const r = resolveTarget(
    { unit: 'km', value: 350 },
    { ...base, estimatedSocPct: 60, soc: 60, range: 300, capacity: 60 },
  )
  expect(r.resolvedSoc).toBe(70)
  expect(r.source).toBe('soc-capacity')
  expect(r.requiredKWh).toBeCloseTo((0.1 * 60) / 0.92, 3)
})

test('resolveTarget: kwh → target-kwh rung, resolvedSoc null (energy amount, not a state)', () => {
  const r = resolveTarget({ unit: 'kwh', value: 40 }, { ...base, capacity: 60 })
  expect(r.source).toBe('target-kwh')
  expect(r.resolvedSoc).toBeNull()
  expect(r.requiredKWh).toBe(40)
})

test('resolveTarget: km with no reading, and a null target, both degrade to duty-cycle', () => {
  const kmNoCar = resolveTarget(
    { unit: 'km', value: 350 },
    { ...base, estimatedSocPct: 60, capacity: 60 },
  )
  expect(kmNoCar.source).toBe('duty-cycle')
  expect(kmNoCar.resolvedSoc).toBeNull()
  const noTarget = resolveTarget(null, { ...base })
  expect(noTarget.source).toBe('duty-cycle')
  expect(noTarget.resolvedSoc).toBeNull()
})
