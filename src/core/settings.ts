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

/** The effective SITE timezone (what the user reasons about — night window, plans, targets). */
export function getTimezone(db: DatabaseSync): string {
  return getSetting(db, 'timezone') ?? DEFAULT_TIMEZONE
}

/** Set the site timezone; throws on a non-IANA value (guards the API + config). */
export function setTimezone(db: DatabaseSync, tz: string): void {
  if (!isValidTimeZone(tz)) throw new Error(`invalid IANA timezone: ${tz}`)
  setSetting(db, 'timezone', tz)
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
