import { test, expect } from 'vitest'
import {
  resolveSessionComplete,
  SESSION_COMPLETE,
  type SessionCompleteInput,
} from './session-complete.js'

// A drawing car that has delivered energy toward a met SoC target, at t = 100_000 ms.
const base: SessionCompleteInput = {
  connected: true,
  climateActive: false,
  deliveredKWh: 17.7,
  commandedA: 16,
  drawingA: 0, // not drawing (the interesting case)
  requiredKWh: 5, // target NOT yet met by default
  energySource: 'soc-capacity',
  zeroDrawSinceMs: undefined,
  now: 100_000,
}
const cfg = SESSION_COMPLETE

test('not connected / climatising / nothing delivered / actively drawing → never complete, timer cleared', () => {
  expect(resolveSessionComplete({ ...base, connected: false }, cfg)).toEqual({
    complete: false,
    zeroDrawSinceMs: undefined,
  })
  expect(resolveSessionComplete({ ...base, climateActive: true }, cfg).complete).toBe(false)
  // initial ramp: offered current, 0 A, but nothing delivered yet → not "done", it never started
  expect(resolveSessionComplete({ ...base, deliveredKWh: 0 }, cfg).complete).toBe(false)
  // actively drawing (Fast charging past an OSC target) → not complete, and the settle timer resets
  expect(
    resolveSessionComplete({ ...base, drawingA: 13, zeroDrawSinceMs: 1 }, cfg),
  ).toEqual({ complete: false, zeroDrawSinceMs: undefined })
})

test('socTargetReached: a real SoC target met → complete immediately (even when not offering current)', () => {
  // Smart mode at target: requiredKWh 0, not offering (commandedA 0), not drawing → Ready now.
  expect(
    resolveSessionComplete(
      { ...base, requiredKWh: 0, commandedA: 0, energySource: 'soc-capacity' },
      cfg,
    ).complete,
  ).toBe(true)
})

test('guest kWh estimate is NEVER a completion trigger (target-kwh rung)', () => {
  // requiredKWh 0 on the kWh rung → planning estimate, not a stop. Only the car stopping completes it.
  expect(
    resolveSessionComplete(
      { ...base, requiredKWh: 0, commandedA: 0, energySource: 'target-kwh' },
      cfg,
    ).complete,
  ).toBe(false)
  // duty-cycle rung likewise never completes on requiredKWh
  expect(
    resolveSessionComplete(
      { ...base, requiredKWh: 0, commandedA: 0, energySource: 'duty-cycle' },
      cfg,
    ).complete,
  ).toBe(false)
})

test('carStoppedItself: offering current + car at ~0 A anchors the settle timer, then completes after settleMs', () => {
  // First 0 A tick while offering: anchor the timer, not yet complete.
  const first = resolveSessionComplete(
    { ...base, requiredKWh: 5, zeroDrawSinceMs: undefined, now: 100_000 },
    cfg,
  )
  expect(first).toEqual({ complete: false, zeroDrawSinceMs: 100_000 })

  // Still within the window → not complete, timer preserved.
  expect(
    resolveSessionComplete({ ...base, zeroDrawSinceMs: 100_000, now: 100_000 + cfg.settleMs - 1 }, cfg),
  ).toEqual({ complete: false, zeroDrawSinceMs: 100_000 })

  // At/after the window → complete (the car refused what we offered = done).
  expect(
    resolveSessionComplete({ ...base, zeroDrawSinceMs: 100_000, now: 100_000 + cfg.settleMs }, cfg)
      .complete,
  ).toBe(true)
})

test('not offering current (paused for a cheap window) → not complete, settle timer cleared', () => {
  // Smart cheap-window pause: still need charge (requiredKWh>0), not offering, not drawing → waiting,
  // not done — and any prior settle anchor is dropped so it never accrues while we intentionally pause.
  expect(
    resolveSessionComplete({ ...base, commandedA: 0, requiredKWh: 5, zeroDrawSinceMs: 100_000 }, cfg),
  ).toEqual({ complete: false, zeroDrawSinceMs: undefined })
})
