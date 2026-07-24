import type { DatabaseSync } from 'node:sqlite'
import type { Config } from './config.js'
import { isValidTimeZone } from '../sdk/local-time.js'

// System-wide settings live in the `settings` KV table. Same seed→DB-wins→config:apply model as
// loadpoint state: osc.yaml `site.*` seeds a fresh DB; runtime writes (e.g. the UI setup flow
// auto-detecting the browser timezone) win thereafter; `npm run config:apply` re-asserts config.

const DEFAULT_TIMEZONE = 'Europe/Stockholm'

export function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value)
}

// Whether the DB config store has been seeded from osc.yaml. Unset on a fresh (or cleared) DB → the
// lifecycle imports osc.yaml once, then sets this so the file becomes inert (edit via API / re-import).
const MATERIALIZED_KEY = 'config.materialized'
export function isConfigMaterialized(db: DatabaseSync): boolean {
  return getSetting(db, MATERIALIZED_KEY) === '1'
}
export function setConfigMaterialized(db: DatabaseSync): void {
  setSetting(db, MATERIALIZED_KEY, '1')
}

/** The effective SITE timezone (what the user reasons about — night window, plans, targets). */
export function getTimezone(db: DatabaseSync): string {
  return getSetting(db, 'timezone') ?? DEFAULT_TIMEZONE
}

/** Set the site timezone; throws on a non-IANA value (guards the API + config). */
export function setTimezone(db: DatabaseSync, tz: string): void {
  if (!isValidTimeZone(tz)) throw new Error(`invalid IANA timezone: ${tz}`)
  setSetting(db, 'timezone', tz)
}

const DEFAULT_LOG_RETENTION_DAYS = 3

/**
 * How many days of runtime logs to keep before auto-rotation drops them (default 3). Pure runtime — a
 * user knob on the Logs page, not seeded from config. Falls back to the default on a missing/corrupt value.
 */
export function getLogRetentionDays(db: DatabaseSync): number {
  const raw = getSetting(db, 'logs.retention_days')
  const n = raw != null ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_LOG_RETENTION_DAYS
}

/** Set the log-retention window (days); throws outside 1–365 (guards the API). */
export function setLogRetentionDays(db: DatabaseSync, days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error(`logRetentionDays must be an integer 1–365, got ${days}`)
  }
  setSetting(db, 'logs.retention_days', String(days))
}

/** Seed settings from config on boot — new DB only (INSERT OR IGNORE); runtime values win after. */
export function seedSettings(db: DatabaseSync, config: Config): void {
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(
    'timezone',
    config.site.timezone,
  )
}

/** Declaratively overwrite settings from config (config:apply) — never on boot. */
export function applyConfigSettings(db: DatabaseSync, config: Config): void {
  setSetting(db, 'timezone', config.site.timezone)
}
