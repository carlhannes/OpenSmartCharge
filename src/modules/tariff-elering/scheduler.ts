// Stockholm-local time helpers — DST-safe via Intl.
// Handles the CET (UTC+1) / CEST (UTC+2) switch automatically.

const STOCKHOLM_TZ = 'Europe/Stockholm'
const PUBLISH_HOUR = 13
const PUBLISH_MINUTE = 15

export interface SchedulerState {
  consecutiveFailures: number
}

export interface ScheduleDecision {
  delayMs: number
  reason: 'startup' | 'wait-for-window' | 'retry' | 'next-day'
}

function stockholmParts(d: Date): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
} {
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

// Returns ms until the next occurrence of HH:MM in Stockholm local time (same day or tomorrow).
export function msUntilStockholmTime(now: Date, hour: number, minute: number): number {
  const p = stockholmParts(now)
  const pad = (n: number) => String(n).padStart(2, '0')

  // Build the target time treating Stockholm local as UTC (a "fake" UTC),
  // then subtract the Stockholm UTC offset to get the real UTC timestamp.
  // Using fakeUTC as the input to getStockholmOffsetMs is correct here because
  // 13:15 Stockholm never falls within the DST transition window (02:00–03:00).
  const fakeUTC = new Date(
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(hour)}:${pad(minute)}:00Z`,
  )
  const target = new Date(fakeUTC.getTime() + getStockholmOffsetMs(fakeUTC))

  if (target.getTime() > now.getTime()) {
    return target.getTime() - now.getTime()
  }
  // Already past today's window → aim for tomorrow
  return target.getTime() + 24 * 3600_000 - now.getTime()
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

// Returns ms until midnight (00:00:00) Stockholm local time on the next day.
function msUntilStockholmMidnight(now: Date): number {
  return msUntilStockholmTime(now, 0, 0)
}

export function isPastPublishWindow(now: Date): boolean {
  const p = stockholmParts(now)
  return p.hour > PUBLISH_HOUR || (p.hour === PUBLISH_HOUR && p.minute >= PUBLISH_MINUTE)
}

export function nextDelay(
  state: SchedulerState,
  haveTomorrow: boolean,
  now: Date,
): ScheduleDecision {
  if (haveTomorrow) {
    return { delayMs: msUntilStockholmTime(now, PUBLISH_HOUR, PUBLISH_MINUTE), reason: 'next-day' }
  }

  if (!isPastPublishWindow(now)) {
    return {
      delayMs: msUntilStockholmTime(now, PUBLISH_HOUR, PUBLISH_MINUTE),
      reason: 'wait-for-window',
    }
  }

  // Past publish window, don't have tomorrow yet — retry chain
  const n = state.consecutiveFailures
  const delayMs =
    n === 0
      ? 30 * 60_000 // first retry: +30 min
      : Math.pow(2, n - 1) * 3600_000 // subsequent: 1h, 2h, 4h, …

  const tillMidnight = msUntilStockholmMidnight(now)
  if (delayMs >= tillMidnight) {
    return { delayMs: msUntilStockholmTime(now, PUBLISH_HOUR, PUBLISH_MINUTE), reason: 'next-day' }
  }

  return { delayMs, reason: 'retry' }
}
