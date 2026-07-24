// Local wall-clock helpers, parameterized by IANA timezone — DST-safe via Intl (CET/CEST etc).
//
// The timezone is ALWAYS a parameter, never hardcoded. Core smart-charging + plans pass the
// configurable SITE timezone (see core/settings.ts getTimezone); Nord Pool tariff providers pass
// their MARKET timezone (Europe/Stockholm) — publish windows + per-day price files follow the
// price market, not where the user lives.

export interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  /** 0 = Monday … 6 = Sunday. */
  weekday: number
}

// Intl 'short' weekday (en-US) → 0=Mon..6=Sun.
const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
}

export function localParts(d: Date, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(d)
  const val = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const num = (type: string) => Number(val(type) || 0)
  return {
    year: num('year'),
    month: num('month'),
    day: num('day'),
    hour: num('hour') % 24, // hour12:false can render midnight as '24' in some engines
    minute: num('minute'),
    weekday: WEEKDAY_INDEX[val('weekday')] ?? 0,
  }
}

/** Local hour of day (0–23) in `tz`. */
export function localHour(d: Date, tz: string): number {
  return localParts(d, tz).hour
}

/** Local weekday in `tz`: 0 = Monday … 6 = Sunday. */
export function localWeekday(d: Date, tz: string): number {
  return localParts(d, tz).weekday
}

/** Local calendar-day key 'YYYY-MM-DD' in `tz`. */
export function localDateKey(d: Date, tz: string): string {
  const p = localParts(d, tz)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/**
 * True when the local hour in `tz` is within the night window [startHour, endHour).
 * A window with startHour > endHour wraps midnight, e.g. isNight(d, 23, 5, tz) covers
 * 23:00–04:59 local.
 */
export function isNight(d: Date, startHour: number, endHour: number, tz: string): boolean {
  const h = localHour(d, tz)
  return startHour <= endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour
}

// -(UTC offset of `tz`) at the given Date. e.g. CET (UTC+1) → -3 600 000; CEST → -7 200 000.
// Adding this to a "fake UTC built from local parts" gives the correct real UTC.
function getOffsetMs(d: Date, tz: string): number {
  const p = localParts(d, tz)
  const pad = (n: number) => String(n).padStart(2, '0')
  const fakeUtcStr = `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00Z`
  return d.getTime() - new Date(fakeUtcStr).getTime()
}

/** Ms until the next occurrence of HH:MM in `tz` local time (same day or tomorrow). */
export function msUntilLocalTime(now: Date, hour: number, minute: number, tz: string): number {
  const p = localParts(now, tz)
  const pad = (n: number) => String(n).padStart(2, '0')
  // Build the target as "fake UTC" from local parts, then subtract the local offset to get real
  // UTC. Safe for the times we use it (publish window, midnight, plan ready-by) — none sit in the
  // 02:00–03:00 DST gap.
  const fakeUTC = new Date(
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(hour)}:${pad(minute)}:00Z`,
  )
  const target = new Date(fakeUTC.getTime() + getOffsetMs(fakeUTC, tz))
  if (target.getTime() > now.getTime()) return target.getTime() - now.getTime()
  // Already past today's occurrence → aim for tomorrow.
  return target.getTime() + 24 * 3600_000 - now.getTime()
}

/** Ms until 00:00 local (`tz`) on the next day. */
export function msUntilLocalMidnight(now: Date, tz: string): number {
  return msUntilLocalTime(now, 0, 0, tz)
}

/** True if `tz` is an IANA timezone the runtime accepts (used to validate config/API input). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
