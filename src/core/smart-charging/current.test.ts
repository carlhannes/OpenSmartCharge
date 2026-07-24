import { test, expect } from 'vitest'
import { resolveCurrentBudget } from './current.js'

const TZ = 'Europe/Stockholm'
const NIGHT = { startHour: 23, endHour: 5 }
const nightNow = new Date('2026-07-04T22:00:00Z') // 00:00 CEST → night
const dayNow = new Date('2026-07-04T10:00:00Z') // 12:00 CEST → day

test('live-meter rung: mainBreaker − maxPhase + ownDraw, clamped to charger maxA', () => {
  const r = resolveCurrentBudget({
    now: dayNow,
    maxCurrentA: 16,
    mainBreakerA: 25,
    liveMaxPhaseA: 10,
    ownDrawA: 6,
    nightWindow: NIGHT,
    tz: TZ,
  })
  expect(r).toMatchObject({ value: 16, source: 'live-meter', degraded: false }) // 25−10+6=21 → clamp 16
})

test('circuit budget clamps to the breaker even with a large credit-back (safety ceiling)', () => {
  // Balancer circuit: maxCurrentA = mainBreakerA = 25. A big multi-charger credit-back pushes the
  // raw headroom past the fuse; settle() clamps it so the split can never over-subscribe the breaker.
  const r = resolveCurrentBudget({
    now: dayNow,
    maxCurrentA: 25,
    mainBreakerA: 25,
    liveMaxPhaseA: 10,
    ownDrawA: 20, // 25 − 10 + 20 = 35, clamped to 25
    nightWindow: NIGHT,
    tz: TZ,
  })
  expect(r).toMatchObject({ value: 25, source: 'live-meter' })
})

test('live-meter rung: credit-back avoids a phantom zero during ramp-up', () => {
  // House at 20 A including our own 6 A: raw headroom 5 A (<6→0), but credit-back gives 11 A.
  const r = resolveCurrentBudget({
    now: dayNow,
    maxCurrentA: 16,
    mainBreakerA: 25,
    liveMaxPhaseA: 20,
    ownDrawA: 6,
    nightWindow: NIGHT,
    tz: TZ,
  })
  expect(r.value).toBe(11)
})

test('historical-worstcase rung: mainBreaker − worstLoad − 1', () => {
  const r = resolveCurrentBudget({
    now: dayNow,
    maxCurrentA: 16,
    mainBreakerA: 25,
    worstCaseLoadA: 12,
    nightWindow: NIGHT,
    tz: TZ,
  })
  expect(r).toMatchObject({ value: 12, source: 'historical-worstcase', degraded: true }) // 25−12−1
})

test('static-tod rung: night = breaker − margin, day = breaker × fraction', () => {
  expect(
    resolveCurrentBudget({
      now: nightNow,
      maxCurrentA: 32,
      mainBreakerA: 16,
      nightWindow: NIGHT,
      tz: TZ,
    }),
  ).toMatchObject({
    value: 13, // 16 − 3
    source: 'static-tod',
  })
  expect(
    resolveCurrentBudget({
      now: dayNow,
      maxCurrentA: 32,
      mainBreakerA: 16,
      nightWindow: NIGHT,
      tz: TZ,
    }).value,
  ).toBe(8) // 16 × 0.5
})

test('a budget below the 6 A IEC minimum resolves to 0, never rounded up', () => {
  // 10 A breaker, daytime 50% = 5 A < 6 A.
  expect(
    resolveCurrentBudget({
      now: dayNow,
      maxCurrentA: 16,
      mainBreakerA: 10,
      nightWindow: NIGHT,
      tz: TZ,
    }).value,
  ).toBe(0)
})

test('no mainBreakerA → charger maxA is the ceiling (dedicated circuit, not degraded)', () => {
  expect(
    resolveCurrentBudget({ now: dayNow, maxCurrentA: 10, nightWindow: NIGHT, tz: TZ }),
  ).toMatchObject({
    value: 10,
    source: 'static-tod',
    degraded: false,
  })
})

test('reserveA shrinks the live-meter budget: target is (mainBreaker − reserveA)', () => {
  // (16 − 2) − 6 + 6 = 14 — 2 A below what it would be without the reserve, so steady state sits a
  // margin below the 16 A fuse (a load step has room before it trips).
  const r = resolveCurrentBudget({
    now: dayNow,
    maxCurrentA: 16,
    mainBreakerA: 16,
    liveMaxPhaseA: 6,
    ownDrawA: 6,
    reserveA: 2,
    nightWindow: NIGHT,
    tz: TZ,
  })
  expect(r).toMatchObject({ value: 14, source: 'live-meter' })
})

test('reserveA also applies to the historical rung: (mainBreaker − reserveA) − worst − 1', () => {
  const r = resolveCurrentBudget({
    now: dayNow,
    maxCurrentA: 16,
    mainBreakerA: 25,
    worstCaseLoadA: 12,
    reserveA: 2,
    nightWindow: NIGHT,
    tz: TZ,
  })
  expect(r.value).toBe(10) // 25 − 2 − 12 − 1
})

test('reserveA is NOT stacked onto static-tod (it already carries nightMargin/daytimeFraction)', () => {
  // Night: 16 − nightMargin(3) = 13, regardless of reserveA — no double margin on the deepest fallback.
  expect(
    resolveCurrentBudget({
      now: nightNow,
      maxCurrentA: 32,
      mainBreakerA: 16,
      reserveA: 5,
      nightWindow: NIGHT,
      tz: TZ,
    }).value,
  ).toBe(13)
})
