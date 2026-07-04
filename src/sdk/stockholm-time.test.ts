import { test, expect } from 'vitest'
import {
  stockholmHour,
  stockholmDateKey,
  isNight,
  msUntilStockholmTime,
} from './stockholm-time.js'

// All helpers pin Europe/Stockholm via Intl, so results are independent of the host TZ.

test('stockholmHour / stockholmDateKey convert UTC → Stockholm local (CEST, summer)', () => {
  // 2026-07-04 is summer → CEST (UTC+2).
  expect(stockholmHour(new Date('2026-07-04T10:00:00Z'))).toBe(12)
  expect(stockholmDateKey(new Date('2026-07-04T10:00:00Z'))).toBe('2026-07-04')
  // 22:30Z is already the next Stockholm day.
  expect(stockholmHour(new Date('2026-07-04T22:30:00Z'))).toBe(0)
  expect(stockholmDateKey(new Date('2026-07-04T22:30:00Z'))).toBe('2026-07-05')
})

test('stockholmHour handles the CET/CEST DST switches', () => {
  // Spring-forward 2026-03-29: 02:00 CET → 03:00 CEST at 01:00 UTC; local 02:xx is skipped.
  expect(stockholmHour(new Date('2026-03-29T00:30:00Z'))).toBe(1) // 01:30 CET
  expect(stockholmHour(new Date('2026-03-29T01:30:00Z'))).toBe(3) // 03:30 CEST (02:xx skipped)
  // Fall-back 2026-10-25: 03:00 CEST → 02:00 CET at 01:00 UTC; local 02:xx occurs twice.
  expect(stockholmHour(new Date('2026-10-25T00:30:00Z'))).toBe(2) // 02:30 CEST
  expect(stockholmHour(new Date('2026-10-25T01:30:00Z'))).toBe(2) // 02:30 CET (repeat)
})

test('isNight covers the wrapping 23:00–05:00 window in local time', () => {
  const night = (iso: string) => isNight(new Date(iso), 23, 5)
  expect(night('2026-07-04T21:30:00Z')).toBe(true) // 23:30 local
  expect(night('2026-07-04T02:30:00Z')).toBe(true) // 04:30 local
  expect(night('2026-07-04T03:00:00Z')).toBe(false) // 05:00 local (window end, exclusive)
  expect(night('2026-07-04T20:59:00Z')).toBe(false) // 22:59 local
  expect(night('2026-07-04T10:00:00Z')).toBe(false) // 12:00 local
})

test('msUntilStockholmTime targets the next 13:15 Stockholm occurrence', () => {
  // Before today's window: 09:00Z = 11:00 CEST → next 13:15 local (11:15Z) is 2h15m away.
  expect(msUntilStockholmTime(new Date('2026-07-04T09:00:00Z'), 13, 15)).toBe(2 * 3600_000 + 15 * 60_000)
  // After today's window: 12:00Z = 14:00 CEST → aim for tomorrow 13:15 local (23h15m away).
  expect(msUntilStockholmTime(new Date('2026-07-04T12:00:00Z'), 13, 15)).toBe(23 * 3600_000 + 15 * 60_000)
})
