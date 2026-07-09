import type { ModuleHealth } from '../sdk/types.js'

// ── Shared resilience primitives for data sources (vehicle polls, tariff fetches, …) ───────────
//
// Two pure functions that give any pollable/fetchable source the same self-healing behaviour the
// system lacked (a stale source used to report `ok` forever, and a failed fetch waited a full
// interval before retrying):
//   - backoffDelayMs: capped exponential backoff so a transient failure retries in seconds→minutes,
//     recovering fast when connectivity returns, without hammering a down endpoint.
//   - sourceHealth: derives ok/degraded/unavailable from recent failures and (optionally, for
//     sources with a known cadence) the age of the last success — so an outage is VISIBLE, instead
//     of a non-null stale cache masquerading as healthy.
//
// They're intentionally pure + data-only (no timers, no I/O) so each source keeps ownership of its
// own cadence (the lifecycle drives vehicle polls on demand; the tariff self-schedules) and stays
// exhaustively unit-testable.

export interface BackoffCfg {
  /** Delay after the FIRST failure (ms). */
  baseMs: number
  /** Multiplier per additional consecutive failure. */
  factor: number
  /** Ceiling — the backoff never grows past this (ms). */
  maxMs: number
}

/**
 * Capped exponential backoff for `consecutiveFailures` (1 = first failure). Returns 0 when there
 * are no failures, i.e. "use the normal cadence". Growth: baseMs, baseMs·factor, baseMs·factor²…,
 * clamped to maxMs.
 */
export function backoffDelayMs(consecutiveFailures: number, cfg: BackoffCfg): number {
  if (consecutiveFailures <= 0) return 0
  const raw = cfg.baseMs * Math.pow(cfg.factor, consecutiveFailures - 1)
  return Math.min(raw, cfg.maxMs)
}

export interface SourceHealthInput {
  /** Consecutive failed attempts (reset to 0 on any success). */
  consecutiveFailures: number
  /** Force `unavailable` regardless of the counts — e.g. auth permanently dead, or no data yet. */
  hardDown?: boolean
  /**
   * Age of the last SUCCESSFUL fetch (ms). Omit for demand-polled sources where idle staleness is
   * expected and NOT a fault (e.g. a parked car we deliberately don't poll) — those rely on the
   * failure count alone. Provide it only for sources with a known refresh cadence (e.g. a daily
   * tariff), paired with `staleAfterMs`.
   */
  ageMs?: number
  /** Above this age (ms) the last success is considered stale → at least `degraded`. */
  staleAfterMs?: number
  /** Failures at/above which health is `degraded` (default 1). */
  degradeAfterFailures?: number
  /** Failures at/above which health is `unavailable` (default 3). */
  unavailableAfterFailures?: number
}

/**
 * Derive staleness/failure-aware health. Pure. The ladder: hard-down → unavailable; too many
 * consecutive failures → unavailable; stale-past-threshold OR any recent failure → degraded; else ok.
 */
export function sourceHealth(i: SourceHealthInput): ModuleHealth {
  if (i.hardDown) return 'unavailable'
  const degradeAt = i.degradeAfterFailures ?? 1
  const unavailableAt = i.unavailableAfterFailures ?? 3
  if (i.consecutiveFailures >= unavailableAt) return 'unavailable'
  const stale = i.ageMs !== undefined && i.staleAfterMs !== undefined && i.ageMs > i.staleAfterMs
  if (stale || i.consecutiveFailures >= degradeAt) return 'degraded'
  return 'ok'
}
