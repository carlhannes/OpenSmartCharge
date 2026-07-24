import { test, expect } from 'vitest'
import { backoffDelayMs, sourceHealth, type BackoffCfg } from './source-reconciler.js'

const cfg: BackoffCfg = { baseMs: 15_000, factor: 2, maxMs: 300_000 }

test('backoffDelayMs: 0 failures → 0 (normal cadence); then capped exponential growth', () => {
  expect(backoffDelayMs(0, cfg)).toBe(0)
  expect(backoffDelayMs(-1, cfg)).toBe(0)
  expect(backoffDelayMs(1, cfg)).toBe(15_000) // base
  expect(backoffDelayMs(2, cfg)).toBe(30_000)
  expect(backoffDelayMs(3, cfg)).toBe(60_000)
  expect(backoffDelayMs(5, cfg)).toBe(240_000)
  expect(backoffDelayMs(6, cfg)).toBe(300_000) // clamped at maxMs
  expect(backoffDelayMs(20, cfg)).toBe(300_000) // stays clamped
})

test('sourceHealth: failure-count ladder (the demand-polled vehicle case — no staleness input)', () => {
  expect(sourceHealth({ consecutiveFailures: 0 })).toBe('ok')
  expect(sourceHealth({ consecutiveFailures: 1 })).toBe('degraded')
  expect(sourceHealth({ consecutiveFailures: 2 })).toBe('degraded')
  expect(sourceHealth({ consecutiveFailures: 3 })).toBe('unavailable')
  // hardDown (auth dead / no data yet) wins regardless of counts.
  expect(sourceHealth({ consecutiveFailures: 0, hardDown: true })).toBe('unavailable')
})

test('sourceHealth: staleness makes a stale-but-not-failing source degraded (known-cadence case)', () => {
  const staleAfterMs = 26 * 3600_000
  // Fresh success, no failures → ok.
  expect(sourceHealth({ consecutiveFailures: 0, ageMs: 60_000, staleAfterMs })).toBe('ok')
  // Last success older than the threshold, even with zero failures → degraded (the outage the old
  // "non-null cache == ok" health missed).
  expect(sourceHealth({ consecutiveFailures: 0, ageMs: 30 * 3600_000, staleAfterMs })).toBe(
    'degraded',
  )
  // Enough failures still escalates to unavailable regardless of age.
  expect(sourceHealth({ consecutiveFailures: 3, ageMs: 60_000, staleAfterMs })).toBe('unavailable')
})

test('sourceHealth: custom thresholds', () => {
  expect(
    sourceHealth({ consecutiveFailures: 2, degradeAfterFailures: 2, unavailableAfterFailures: 5 }),
  ).toBe('degraded')
  expect(
    sourceHealth({ consecutiveFailures: 5, degradeAfterFailures: 2, unavailableAfterFailures: 5 }),
  ).toBe('unavailable')
})
