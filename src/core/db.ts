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
  `)
}
