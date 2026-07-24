import { test, expect } from 'vitest'
import { pushPowerSample, type PowerSample } from './power-history.js'

test('appends when ≥10s apart, throttles when closer', () => {
  const buf: PowerSample[] = []
  const t0 = 1_000_000
  pushPowerSample(buf, 3000, 1000, t0)
  pushPowerSample(buf, 3200, 1100, t0 + 5_000) // <10s → throttled (dropped)
  pushPowerSample(buf, 3400, 1200, t0 + 10_000) // ≥10s → appended
  expect(buf.map((s) => s.total)).toEqual([3000, 3400])
  expect(buf.map((s) => s.ev)).toEqual([1000, 1200])
})

test('prunes samples older than the 15-min window', () => {
  const buf: PowerSample[] = []
  const t0 = 1_000_000
  pushPowerSample(buf, 100, 0, t0)
  pushPowerSample(buf, 200, 0, t0 + 10 * 60_000)
  pushPowerSample(buf, 300, 0, t0 + 20 * 60_000) // now t0 is >15 min old → pruned
  expect(buf.map((s) => s.total)).toEqual([200, 300])
})

test('mutates the buffer in place (reference stays valid for the API layer)', () => {
  const buf: PowerSample[] = []
  const ref = buf
  pushPowerSample(buf, 500, 0, 1_000_000)
  expect(ref).toBe(buf)
  expect(ref).toHaveLength(1)
})
