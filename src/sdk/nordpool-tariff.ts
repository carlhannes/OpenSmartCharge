// Shared toolkit for Nord Pool day-ahead tariff providers.
//
// Every Nord Pool provider (Elering for EE/FI/LV/LT, elprisetjustnu for SE1–SE4, …)
// does the same thing: fetch day-ahead slots, persist them to `tariff_slots`, expose
// health, and re-fetch after the ~13:00 CET publish. Only the HTTP fetch+parse differs.
// `createNordpoolDayAheadTariff` captures the common orchestration, parameterized by a
// provider `fetchSlots` function, so each provider module is just its `api.ts` + a
// registration.

import type { DatabaseSync } from 'node:sqlite'
import type { ModuleCtx, ModuleHealth } from './types.js'
import type { Tariff, TariffSlot } from './tariff.js'
import { localParts, msUntilLocalTime } from './local-time.js'
import { backoffDelayMs, type BackoffCfg } from './source-reconciler.js'

// Nord Pool day-ahead prices publish ~13:00 CET; wait until 13:15 to fetch. This is the price
// MARKET's timezone (Nord Pool = CET/CEST), NOT the site/user timezone — the publish window +
// per-day slot boundaries follow the market regardless of where the user lives.
export const MARKET_TZ = 'Europe/Stockholm'
// Per-request HTTP timeout for the price APIs (the schedule, not the request, carries the jitter).
export const FETCH_TIMEOUT_MS = 15_000
const PUBLISH_HOUR = 13
const PUBLISH_MINUTE = 15
// After-publish retry backoff. A missing "tomorrow" past the publish window is a fetch FAILURE
// (network/provider), not "not published yet". Start SHORT — a transient blip usually clears within
// minutes — and grow exponentially, but CAP at hourly so we keep retrying until it succeeds instead
// of letting the backoff grow past midnight and stranding empty prices ~24 h.
// 10 → 20 → 40 → 60 min.
const RETRY_BACKOFF: BackoffCfg = { baseMs: 10 * 60_000, factor: 2, maxMs: 60 * 60_000 }
// Herd-spreading: every OSC instance would otherwise fetch at exactly 13:15:00. The random offset
// lives in the SCHEDULE (one per run), not inside fetch — so per-request timeouts keep working.
const SCHEDULE_JITTER_MS = 120_000

/**
 * Thrown by a provider's `fetchSlots` when the configured zone is absent from the
 * response — a PERMANENT misconfiguration, so the scheduler must not retry it.
 */
export class ZoneNotFoundError extends Error {
  constructor(zone: string, provider: string) {
    super(`${provider}: zone '${zone}' not found in response`)
    this.name = 'ZoneNotFoundError'
  }
}

// ── tariff_slots persistence (shared across providers) ───────────────────────

export function upsertSlots(db: DatabaseSync, zone: string, slots: TariffSlot[]): void {
  if (slots.length === 0) return
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO tariff_slots (zone, slot_start, slot_end, price_per_kwh, currency)
     VALUES (?, ?, ?, ?, ?)`,
  )
  // The connection is shared by the whole app: a transaction left open by a failed insert would hold
  // every later write uncommitted (lost on exit) and make every later BEGIN throw — roll it back.
  db.exec('BEGIN')
  try {
    for (const slot of slots) {
      stmt.run(
        zone,
        slot.start.toISOString(),
        slot.end.toISOString(),
        slot.pricePerKWh,
        slot.currency,
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function getSlots(db: DatabaseSync, zone: string, from: Date, to: Date): TariffSlot[] {
  const rows = db
    .prepare(
      `SELECT slot_start, slot_end, price_per_kwh, currency
       FROM tariff_slots
       WHERE zone = ? AND slot_start >= ? AND slot_start < ?
       ORDER BY slot_start`,
    )
    .all(zone, from.toISOString(), to.toISOString()) as {
    slot_start: string
    slot_end: string
    price_per_kwh: number
    currency: string
  }[]

  return rows.map((r) => ({
    start: new Date(r.slot_start),
    end: new Date(r.slot_end),
    pricePerKWh: r.price_per_kwh,
    currency: r.currency,
  }))
}

/** Latest cached slot_end for the zone, or null if none. */
export function latestSlotEnd(db: DatabaseSync, zone: string): Date | null {
  const row = db
    .prepare(`SELECT MAX(slot_end) AS max_end FROM tariff_slots WHERE zone = ?`)
    .get(zone) as { max_end: string | null }
  return row.max_end ? new Date(row.max_end) : null
}

// ── scheduling (13:15 Stockholm publish window + retry backoff) ──────────────

export interface SchedulerState {
  consecutiveFailures: number
}

export interface ScheduleDecision {
  delayMs: number
  reason: 'startup' | 'wait-for-window' | 'retry' | 'next-day'
}

export function isPastPublishWindow(now: Date): boolean {
  const p = localParts(now, MARKET_TZ)
  return p.hour > PUBLISH_HOUR || (p.hour === PUBLISH_HOUR && p.minute >= PUBLISH_MINUTE)
}

/** True when cached data extends >20h into the future (i.e. covers tomorrow). */
export function hasTomorrow(db: DatabaseSync, zone: string, now: Date = new Date()): boolean {
  const latest = latestSlotEnd(db, zone)
  return latest !== null && latest.getTime() > now.getTime() + 20 * 3600_000
}

export function computeTariffHealth(
  db: DatabaseSync,
  zone: string,
  now: Date = new Date(),
): ModuleHealth {
  const latest = latestSlotEnd(db, zone)
  if (!latest || latest.getTime() <= now.getTime()) return 'unavailable'
  // Before the publish window, having today's data is fine.
  if (!isPastPublishWindow(now)) return 'ok'
  // After the publish window we should have tomorrow; if not → degraded.
  return hasTomorrow(db, zone, now) ? 'ok' : 'degraded'
}

export function nextDelay(
  state: SchedulerState,
  haveTomorrow: boolean,
  now: Date,
): ScheduleDecision {
  if (haveTomorrow) {
    return {
      delayMs: msUntilLocalTime(now, PUBLISH_HOUR, PUBLISH_MINUTE, MARKET_TZ),
      reason: 'next-day',
    }
  }
  if (!isPastPublishWindow(now)) {
    return {
      delayMs: msUntilLocalTime(now, PUBLISH_HOUR, PUBLISH_MINUTE, MARKET_TZ),
      reason: 'wait-for-window',
    }
  }
  // Past publish window, don't have tomorrow yet — a fetch failure, not "not published". Retry with
  // capped exponential backoff: 10 m → 20 m → 40 m → hourly, so a transient network blip recovers in
  // ~10 min instead of stranding for an hour. The cap keeps it retrying rather than backing off past
  // midnight and stranding empty prices ~24 h (which is why it never collapses to "next-day" here).
  return {
    delayMs: backoffDelayMs(Math.max(1, state.consecutiveFailures), RETRY_BACKOFF),
    reason: 'retry',
  }
}

// ── the shared provider factory ──────────────────────────────────────────────

export interface NordpoolTariffOptions {
  name: string
  zone: string
  /** Human label used in logs, e.g. 'Elering' / 'elprisetjustnu'. */
  provider: string
  /**
   * Fetch price slots covering [from, to). Throw {@link ZoneNotFoundError} for a bad
   * zone (permanent — not retried); throw anything else for a transient failure (retried).
   * Receives the global `fetch` (the parameter exists so tests can inject a fake).
   */
  fetchSlots: (
    zone: string,
    from: Date,
    to: Date,
    fetchFn: typeof globalThis.fetch,
  ) => Promise<TariffSlot[]>
  /** Fetch-window width from the current hour, in hours. Default 48. */
  rangeHours?: number
}

export function createNordpoolDayAheadTariff(ctx: ModuleCtx, opts: NordpoolTariffOptions): Tariff {
  const { name, zone, provider, fetchSlots, rangeHours = 48 } = opts
  const state: SchedulerState = { consecutiveFailures: 0 }
  let timer: ReturnType<typeof setTimeout> | undefined
  // A fetch in flight when stop() runs (a reconcile swap) must not re-arm the schedule afterwards —
  // otherwise the discarded instance keeps fetching for the life of the process.
  let stopped = false

  // Fetch range: current hour (truncated) → +rangeHours.
  function fetchRange(): { from: Date; to: Date } {
    const from = new Date()
    from.setMinutes(0, 0, 0)
    return { from, to: new Date(from.getTime() + rangeHours * 3600_000) }
  }

  function scheduleNext(): void {
    if (stopped) return
    // A manual refresh() can overlap an in-flight run; both finish here — keep exactly one timer.
    if (timer !== undefined) clearTimeout(timer)
    const decision = nextDelay(state, hasTomorrow(ctx.db, zone), new Date())
    const jitterMs = Math.floor(Math.random() * SCHEDULE_JITTER_MS)
    ctx.log.info(
      { name, zone, provider, decision, jitterMs },
      'nordpool tariff: next fetch scheduled',
    )
    timer = setTimeout(() => void runOnce(), decision.delayMs + jitterMs)
  }

  async function runOnce(): Promise<void> {
    const { from, to } = fetchRange()
    try {
      const slots = await fetchSlots(zone, from, to, globalThis.fetch)
      upsertSlots(ctx.db, zone, slots)
      state.consecutiveFailures = 0
      ctx.log.info({ name, zone, provider, slots: slots.length }, 'nordpool prices updated')
      ctx.events.emit('tariff.updated', { name, zone })
    } catch (err) {
      if (err instanceof ZoneNotFoundError) {
        // Permanent: wrong zone configured — don't retry, just log.
        ctx.log.error(
          { err, zone, provider },
          'nordpool tariff: zone not found — check your config',
        )
        return
      }
      state.consecutiveFailures++
      ctx.log.warn(
        { err, zone, provider, consecutiveFailures: state.consecutiveFailures },
        'nordpool fetch failed',
      )
    }
    scheduleNext()
  }

  return {
    get id() {
      return name
    },
    // Not awaited: the first fetch must never hold up boot (the HTTP + OCPP listeners start after the
    // modules), and cached prices already serve the planner meanwhile. LAN-survivable by construction.
    async start() {
      void runOnce()
    },
    async stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    },
    // Manual out-of-band refetch (POST /api/tariffs/:name/refresh). Cancels the pending timer and
    // fetches now (no schedule jitter), which reschedules the normal cadence.
    // Never rejects: runOnce swallows fetch errors into health + a retry, so the caller can read
    // health() afterwards to see whether it recovered.
    async refresh() {
      if (timer !== undefined) clearTimeout(timer)
      await runOnce()
    },
    // Derived from the cache on every call (one MAX query), so the periodic health sweep sees the data
    // go stale on its own instead of a value frozen at the last fetch attempt.
    health() {
      return computeTariffHealth(ctx.db, zone)
    },
    async prices(from, to) {
      return getSlots(ctx.db, zone, from, to)
    },
  }
}
