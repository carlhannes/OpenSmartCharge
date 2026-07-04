import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function openDb(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(join(dataDir, 'osc.db'))
  db.exec('PRAGMA journal_mode = WAL')
  runMigrations(db)
  return db
}

function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loadpoint_state (
      name        TEXT PRIMARY KEY,
      mode        TEXT NOT NULL DEFAULT 'smart',
      target_soc  REAL,
      target_time TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      loadpoint_name TEXT NOT NULL,
      station_id     TEXT NOT NULL,
      start_time     TEXT NOT NULL,
      end_time       TEXT,
      energy_kwh     REAL,
      meter_start    REAL,
      id_tag         TEXT
    );

    CREATE TABLE IF NOT EXISTS tariff_slots (
      zone          TEXT NOT NULL,
      slot_start    TEXT NOT NULL,
      slot_end      TEXT NOT NULL,
      price_per_kwh REAL NOT NULL,
      currency      TEXT NOT NULL DEFAULT 'SEK',
      PRIMARY KEY (zone, slot_start)
    );

    CREATE TABLE IF NOT EXISTS vehicle_cache (
      vehicle_name         TEXT PRIMARY KEY,
      soc                  REAL,
      battery_capacity_kwh REAL,
      range_km             REAL,
      is_charging          INTEGER,
      fetched_at           TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meter_values (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      measured_at    TEXT NOT NULL,
      energy_kwh     REAL,
      power_w        REAL,
      current_a      REAL,
      voltage_v      REAL,
      soc            REAL,
      raw            TEXT
    );

    CREATE TABLE IF NOT EXISTS ocpp_tx_counter (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      next_value INTEGER NOT NULL DEFAULT 1
    );
    INSERT OR IGNORE INTO ocpp_tx_counter (id, next_value) VALUES (1, 1);

    CREATE TABLE IF NOT EXISTS module_kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- System-wide settings (key/value). Distinct from module_kv (module-internal state):
    -- these are user/site-level knobs, e.g. the site timezone. Seeded from osc.yaml site.*
    -- and runtime-settable via the API (auto-detected in the UI setup flow).
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Hourly-max rollup of household load (max phase current), keyed by Stockholm-local
    -- calendar day + hour. Feeds the "worst-case current over the last N days" charging
    -- fallback. One row per (date, hour) — bounded at 24 rows/day regardless of meter
    -- cadence, and DST-safe (a repeated local hour collapses via the max() upsert).
    CREATE TABLE IF NOT EXISTS household_load_hourly (
      date        TEXT NOT NULL,
      hour        INTEGER NOT NULL,
      max_phase_a REAL NOT NULL,
      PRIMARY KEY (date, hour)
    );
  `)

  // Additive migrations for pre-existing DBs — `CREATE TABLE IF NOT EXISTS` won't add a
  // column to an already-created table.
  addColumnIfMissing(db, 'transactions', 'meter_start', 'REAL')
  addColumnIfMissing(db, 'loadpoint_state', 'target_kwh', 'REAL')
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}
