import { test, expect } from 'vitest'
import { resolveCurrentBudget } from './current.js'

const NIGHT = { startHour: 23, endHour: 5 }
const nightNow = new Date('2026-07-04T22:00:00Z') // 00:00 CEST → night
const dayNow = new Date('2026-07-04T10:00:00Z') // 12:00 CEST → day

test('live-meter rung: mainBreaker − maxPhase + ownDraw, clamped to charger maxA', () => {
  const r = resolveCurrentBudget({ now: dayNow, maxCurrentA: 16, mainBreakerA: 25, liveMaxPhaseA: 10, ownDrawA: 6, nightWindow: NIGHT })
  expect(r).toMatchObject({ value: 16, source: 'live-meter', degraded: false }) // 25−10+6=21 → clamp 16
})

test('live-meter rung: credit-back avoids a phantom zero during ramp-up', () => {
  // House at 20 A including our own 6 A: raw headroom 5 A (<6→0), but credit-back gives 11 A.
  const r = resolveCurrentBudget({ now: dayNow, maxCurrentA: 16, mainBreakerA: 25, liveMaxPhaseA: 20, ownDrawA: 6, nightWindow: NIGHT })
  expect(r.value).toBe(11)
})

test('historical-worstcase rung: mainBreaker − worstLoad − 1', () => {
  const r = resolveCurrentBudget({ now: dayNow, maxCurrentA: 16, mainBreakerA: 25, worstCaseLoadA: 12, nightWindow: NIGHT })
  expect(r).toMatchObject({ value: 12, source: 'historical-worstcase', degraded: true }) // 25−12−1
})

test('static-tod rung: night = breaker − margin, day = breaker × fraction', () => {
  expect(resolveCurrentBudget({ now: nightNow, maxCurrentA: 32, mainBreakerA: 16, nightWindow: NIGHT })).toMatchObject({
    value: 13, // 16 − 3
    source: 'static-tod',
  })
  expect(resolveCurrentBudget({ now: dayNow, maxCurrentA: 32, mainBreakerA: 16, nightWindow: NIGHT }).value).toBe(8) // 16 × 0.5
})

test('a budget below the 6 A IEC minimum resolves to 0, never rounded up', () => {
  // 10 A breaker, daytime 50% = 5 A < 6 A.
  expect(resolveCurrentBudget({ now: dayNow, maxCurrentA: 16, mainBreakerA: 10, nightWindow: NIGHT }).value).toBe(0)
})

test('no mainBreakerA → charger maxA is the ceiling (dedicated circuit, not degraded)', () => {
  expect(resolveCurrentBudget({ now: dayNow, maxCurrentA: 10, nightWindow: NIGHT })).toMatchObject({
    value: 10,
    source: 'static-tod',
    degraded: false,
  })
})
