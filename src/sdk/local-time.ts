// Local wall-clock helpers, parameterized by IANA timezone — DST-safe via Intl (CET/CEST etc).
//
// The timezone is ALWAYS a parameter, never hardcoded. Core smart-charging + plans pass the
// configurable SITE timezone (see core/settings.ts getTimezone); Nord Pool tariff providers pass
// their MARKET timezone (Europe/Stockholm) — publish windows + per-day price files follow the
// price market, not where the user lives.

/** Wall-clock "HH:MM" as users type it (targets, plan ready-by) — shared by config + API validation. */
export const HHMM_RE = /^\d{2}:\d{2}$/

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
 * True when the local hour in `tz` is within [startHour, endHour). A window with startHour > endHour
 * wraps midnight: (d, 23, 5, tz) is the 23:00–04:59 night window; (d, 6, 22, tz) a daytime window.
 */
export function inLocalHourWindow(
  d: Date,
  startHour: number,
  endHour: number,
  tz: string,
): boolean {
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

/** The instant `hour:minute` occurs in `tz` on the local calendar day (y, m, d). */
function localInstant(
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  // Build the wall-clock time as a "fake UTC" instant, then shift by the zone's offset at that time.
  // Date.UTC normalizes day overflow (d + 1 on the 31st → the 1st of next month). Safe for the times
  // we use it (publish window, plan ready-by, targets) — none sit in the 02:00–03:00 DST gap.
  const fakeUtc = new Date(Date.UTC(y, m - 1, d, hour, minute))
  return new Date(fakeUtc.getTime() + getOffsetMs(fakeUtc, tz))
}

/** Ms until the next occurrence of HH:MM in `tz` local time (same day or tomorrow). */
export function msUntilLocalTime(now: Date, hour: number, minute: number, tz: string): number {
  const p = localParts(now, tz)
  const today = localInstant(p.year, p.month, p.day, hour, minute, tz)
  if (today.getTime() > now.getTime()) return today.getTime() - now.getTime()
  // Already past → tomorrow's wall-clock time, rebuilt from the calendar day: on a DST night "+24 h"
  // would land an hour off (07:00 → 06:00 or 08:00).
  return localInstant(p.year, p.month, p.day + 1, hour, minute, tz).getTime() - now.getTime()
}

/** The next occurrence of "HH:MM" in `tz` — today if still ahead, else tomorrow — as an instant. */
export function nextLocalTime(hhmm: string, now: Date, tz: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(now.getTime() + msUntilLocalTime(now, h, m, tz))
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
