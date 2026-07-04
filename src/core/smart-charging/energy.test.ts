import { test, expect } from 'vitest'
import { resolveEnergyTarget } from './energy.js'

const base = { sessionEnergyKWh: 0, hoursUntilTarget: 8, maxCurrentA: 16, phases: 3 }

test('soc-capacity rung: (target − soc)% × capacity / efficiency', () => {
  const r = resolveEnergyTarget({ ...base, estimatedSocPct: 50, targetSocPct: 80, batteryCapacityKWh: 60 })
  expect(r.source).toBe('soc-capacity')
  expect(r.degraded).toBe(false)
  expect(r.value).toBeCloseTo((0.3 * 60) / 0.92, 3) // ≈ 19.565
})

test('soc-capacity rung: already at/above target → 0', () => {
  const r = resolveEnergyTarget({ ...base, estimatedSocPct: 85, targetSocPct: 80, batteryCapacityKWh: 60 })
  expect(r.value).toBe(0)
  expect(r.source).toBe('soc-capacity')
})

test('target-kwh rung: fixed target minus session energy, converging to 0', () => {
  expect(resolveEnergyTarget({ ...base, targetKWh: 40 })).toMatchObject({ value: 40, source: 'target-kwh', degraded: true })
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
  const r = resolveEnergyTarget({ ...base, estimatedSocPct: 50, batteryCapacityKWh: 60, targetKWh: 30 })
  expect(r.source).toBe('target-kwh')
})
