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

// Nord Pool day-ahead prices publish ~13:00 CET; wait until 13:15 to fetch. This is the price
// MARKET's timezone (Nord Pool = CET/CEST), NOT the site/user timezone — the publish window +
// per-day slot boundaries follow the market regardless of where the user lives.
const MARKET_TZ = 'Europe/Stockholm'
const PUBLISH_HOUR = 13
const PUBLISH_MINUTE = 15
// Cap the after-publish retry backoff. A missing "tomorrow" past the publish window is a fetch
// FAILURE (network/provider), not "not published yet" — so we keep retrying at most hourly until it
// succeeds, instead of letting the backoff grow past midnight and stranding empty prices ~24 h.
const MAX_RETRY_MS = 60 * 60_000

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
  db.exec('BEGIN')
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
  // capped exponential backoff (30 m, then 1 h, then hourly) so connectivity returning recovers
  // within ~1 h. (Previously the backoff could grow past midnight and collapse to "next-day" —
  // 13:15 tomorrow — stranding empty prices for ~24 h with no way to recover sooner.)
  const n = state.consecutiveFailures
  const raw = n === 0 ? 30 * 60_000 : Math.pow(2, n - 1) * 3600_000
  return { delayMs: Math.min(raw, MAX_RETRY_MS), reason: 'retry' }
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
   * Receives the jitter-enabled `ctx.fetch` for scheduled calls or the global `fetch`
   * for the immediate startup call.
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
  let health: ModuleHealth = 'unavailable'

  // Fetch range: current hour (truncated) → +rangeHours.
  function fetchRange(): { from: Date; to: Date } {
    const from = new Date()
    from.setMinutes(0, 0, 0)
    return { from, to: new Date(from.getTime() + rangeHours * 3600_000) }
  }

  function scheduleNext(): void {
    const decision = nextDelay(state, hasTomorrow(ctx.db, zone), new Date())
    ctx.log.info({ name, zone, provider, decision }, 'nordpool tariff: next fetch scheduled')
    timer = setTimeout(() => void runOnce(true), decision.delayMs)
  }

  // scheduled=true → ctx.fetch (jitter, thundering-herd prevention).
  // scheduled=false → global fetch (startup: immediate).
  async function runOnce(scheduled: boolean): Promise<void> {
    const { from, to } = fetchRange()
    try {
      const fetchFn = scheduled ? ctx.fetch : globalThis.fetch
      const slots = await fetchSlots(zone, from, to, fetchFn)
      upsertSlots(ctx.db, zone, slots)
      state.consecutiveFailures = 0
      health = computeTariffHealth(ctx.db, zone)
      ctx.log.info({ name, zone, provider, slots: slots.length }, 'nordpool prices updated')
      ctx.events.emit('tariff.updated', { name, zone })
    } catch (err) {
      if (err instanceof ZoneNotFoundError) {
        // Permanent: wrong zone configured — don't retry, just log.
        ctx.log.error(
          { err, zone, provider },
          'nordpool tariff: zone not found — check your config',
        )
        health = computeTariffHealth(ctx.db, zone)
        return
      }
      state.consecutiveFailures++
      health = computeTariffHealth(ctx.db, zone)
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
    async start() {
      await runOnce(false)
    },
    async stop() {
      if (timer !== undefined) clearTimeout(timer)
    },
    // Manual out-of-band refetch (POST /api/tariffs/:name/refresh). Cancels the pending timer and
    // fetches now (global fetch — immediate, no jitter), which reschedules the normal cadence.
    // Never rejects: runOnce swallows fetch errors into health + a retry, so the caller can read
    // health() afterwards to see whether it recovered.
    async refresh() {
      if (timer !== undefined) clearTimeout(timer)
      await runOnce(false)
    },
    health() {
      return health
    },
    async prices(from, to) {
      return getSlots(ctx.db, zone, from, to)
    },
  }
}
