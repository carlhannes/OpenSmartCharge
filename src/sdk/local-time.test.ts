import { test, expect } from 'vitest'
import {
  localHour,
  localDateKey,
  localWeekday,
  isNight,
  msUntilLocalTime,
  isValidTimeZone,
} from './local-time.js'

const SE = 'Europe/Stockholm'

// All helpers take an explicit IANA tz via Intl, so results are independent of the host TZ.

test('localHour / localDateKey convert UTC → the given tz (Stockholm CEST, summer)', () => {
  // 2026-07-04 is summer → CEST (UTC+2).
  expect(localHour(new Date('2026-07-04T10:00:00Z'), SE)).toBe(12)
  expect(localDateKey(new Date('2026-07-04T10:00:00Z'), SE)).toBe('2026-07-04')
  // 22:30Z is already the next Stockholm day.
  expect(localHour(new Date('2026-07-04T22:30:00Z'), SE)).toBe(0)
  expect(localDateKey(new Date('2026-07-04T22:30:00Z'), SE)).toBe('2026-07-05')
})

test('the tz is a real parameter — same instant, different zones', () => {
  const d = new Date('2026-07-04T10:00:00Z')
  expect(localHour(d, 'UTC')).toBe(10)
  expect(localHour(d, SE)).toBe(12) // CEST = UTC+2
  expect(localHour(d, 'America/New_York')).toBe(6) // EDT = UTC-4
})

test('localHour handles the CET/CEST DST switches', () => {
  // Spring-forward 2026-03-29: 02:00 CET → 03:00 CEST at 01:00 UTC; local 02:xx is skipped.
  expect(localHour(new Date('2026-03-29T00:30:00Z'), SE)).toBe(1) // 01:30 CET
  expect(localHour(new Date('2026-03-29T01:30:00Z'), SE)).toBe(3) // 03:30 CEST (02:xx skipped)
  // Fall-back 2026-10-25: 03:00 CEST → 02:00 CET at 01:00 UTC; local 02:xx occurs twice.
  expect(localHour(new Date('2026-10-25T00:30:00Z'), SE)).toBe(2) // 02:30 CEST
  expect(localHour(new Date('2026-10-25T01:30:00Z'), SE)).toBe(2) // 02:30 CET (repeat)
})

test('localWeekday returns Mon=0..Sun=6 and shifts with the tz', () => {
  const toMon0 = (utcDay: number) => (utcDay + 6) % 7 // JS getUTCDay: 0=Sun..6=Sat
  for (const iso of ['2026-07-04T12:00:00Z', '2026-07-05T12:00:00Z', '2026-07-06T12:00:00Z']) {
    const d = new Date(iso)
    expect(localWeekday(d, 'UTC')).toBe(toMon0(d.getUTCDay()))
  }
  // 23:00 UTC is already the next calendar day in Stockholm (UTC+2) → weekday is one ahead.
  const late = new Date('2026-07-04T23:00:00Z')
  expect((localWeekday(late, SE) - localWeekday(late, 'UTC') + 7) % 7).toBe(1)
})

test('isNight covers the wrapping 23:00–05:00 window in the given tz', () => {
  const night = (iso: string) => isNight(new Date(iso), 23, 5, SE)
  expect(night('2026-07-04T21:30:00Z')).toBe(true) // 23:30 local
  expect(night('2026-07-04T02:30:00Z')).toBe(true) // 04:30 local
  expect(night('2026-07-04T03:00:00Z')).toBe(false) // 05:00 local (window end, exclusive)
  expect(night('2026-07-04T20:59:00Z')).toBe(false) // 22:59 local
  expect(night('2026-07-04T10:00:00Z')).toBe(false) // 12:00 local
})

test('msUntilLocalTime targets the next 13:15 occurrence in the given tz', () => {
  // Before today's window: 09:00Z = 11:00 CEST → next 13:15 local (11:15Z) is 2h15m away.
  expect(msUntilLocalTime(new Date('2026-07-04T09:00:00Z'), 13, 15, SE)).toBe(
    2 * 3600_000 + 15 * 60_000,
  )
  // After today's window: 12:00Z = 14:00 CEST → aim for tomorrow 13:15 local (23h15m away).
  expect(msUntilLocalTime(new Date('2026-07-04T12:00:00Z'), 13, 15, SE)).toBe(
    23 * 3600_000 + 15 * 60_000,
  )
})

test('isValidTimeZone accepts IANA zones and rejects garbage', () => {
  expect(isValidTimeZone('Europe/Stockholm')).toBe(true)
  expect(isValidTimeZone('UTC')).toBe(true)
  expect(isValidTimeZone('America/New_York')).toBe(true)
  expect(isValidTimeZone('Not/AZone')).toBe(false)
  expect(isValidTimeZone('Mars/Phobos')).toBe(false)
})
