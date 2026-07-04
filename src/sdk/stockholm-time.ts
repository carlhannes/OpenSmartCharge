// Stockholm-local time helpers — DST-safe via Intl (handles the CET/CEST switch).
//
// Lives in the SDK because both modules (Nord Pool tariff providers) and core
// (smart-charging night-window + hour-of-day rollup) need wall-clock reasoning in
// Sweden's timezone. Nord Pool day-ahead prices are published on Stockholm local
// time, and a user reasons about "cheap at night" in local hours — never UTC.

const STOCKHOLM_TZ = 'Europe/Stockholm'

export interface StockholmParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

export function stockholmParts(d: Date): StockholmParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: STOCKHOLM_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  }
}

/** Stockholm-local hour of day (0–23) for the given instant. */
export function stockholmHour(d: Date): number {
  return stockholmParts(d).hour
}

/** Stockholm-local calendar-day key 'YYYY-MM-DD' for the given instant. */
export function stockholmDateKey(d: Date): string {
  const p = stockholmParts(d)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/**
 * True when the Stockholm-local hour is within the night window [startHour, endHour).
 * A window with startHour > endHour wraps midnight, e.g. isNight(d, 23, 5) covers
 * 23:00–04:59 local.
 */
export function isNight(d: Date, startHour: number, endHour: number): boolean {
  const h = stockholmHour(d)
  return startHour <= endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour
}

// Returns -(Stockholm UTC offset) at the given Date.
// e.g. CET (UTC+1) → -3 600 000; CEST (UTC+2) → -7 200 000.
// Adding this to a "fake UTC built from Stockholm parts" gives the correct real UTC.
function getStockholmOffsetMs(d: Date): number {
  const p = stockholmParts(d)
  const pad = (n: number) => String(n).padStart(2, '0')
  const fakeUtcStr = `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00Z`
  return d.getTime() - new Date(fakeUtcStr).getTime()
}

/** Ms until the next occurrence of HH:MM in Stockholm local time (same day or tomorrow). */
export function msUntilStockholmTime(now: Date, hour: number, minute: number): number {
  const p = stockholmParts(now)
  const pad = (n: number) => String(n).padStart(2, '0')

  // Build the target treating Stockholm-local parts as UTC ("fake UTC"), then subtract
  // the Stockholm offset to get the real UTC timestamp. Safe for the times we use it
  // (13:15 publish window, 00:00 midnight) — none fall in the 02:00–03:00 DST window.
  const fakeUTC = new Date(
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(hour)}:${pad(minute)}:00Z`,
  )
  const target = new Date(fakeUTC.getTime() + getStockholmOffsetMs(fakeUTC))

  if (target.getTime() > now.getTime()) return target.getTime() - now.getTime()
  // Already past today's occurrence → aim for tomorrow.
  return target.getTime() + 24 * 3600_000 - now.getTime()
}

/** Ms until 00:00 Stockholm-local on the next day. */
export function msUntilStockholmMidnight(now: Date): number {
  return msUntilStockholmTime(now, 0, 0)
}
