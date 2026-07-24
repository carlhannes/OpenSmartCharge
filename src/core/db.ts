import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function openDb(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(join(dataDir, 'osc.db'))
  db.exec('PRAGMA journal_mode = WAL')
  // Wait up to 5s on a locked DB rather than throwing SQLITE_BUSY immediately — hardens both normal
  // writes and the shutdown `wal_checkpoint(TRUNCATE)` against a transient checkpoint/write overlap.
  db.exec('PRAGMA busy_timeout = 5000')
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
      target_soc           REAL,
      plugged_in           INTEGER,
      climate_active       INTEGER,
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

    -- Recurring charging plans, per loadpoint. Weekday-recurring (days_mask, bit i = weekday i,
    -- 0=Mon..6=Sun) + a local ready-by time + a target (value + unit: 'pct'|'km'|'kwh'). The
    -- lifecycle resolves the governing plan each tick (see core/plans.ts) into the single target
    -- the planner already consumes. Runtime/UI-managed (not seeded from config).
    CREATE TABLE IF NOT EXISTS charge_plans (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      loadpoint_name TEXT NOT NULL,
      days_mask      INTEGER NOT NULL,
      ready_by       TEXT NOT NULL,
      target_value   REAL NOT NULL,
      target_unit    TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 1,
      target_vehicles TEXT,
      pause_on_target INTEGER NOT NULL DEFAULT 1,
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_charge_plans_lp ON charge_plans (loadpoint_name);

    -- Runtime overrides of STRUCTURAL config (osc.yaml seeds; DB wins; config:apply re-asserts).
    -- Each row is a JSON patch onto an existing osc.yaml entity, OR a full entity added at runtime
    -- (a claimed charger / added vehicle). Layered over the parsed config by getEffectiveConfig
    -- (core/config-overrides.ts) and re-validated through the same zod schema. Distinct from the
    -- settings KV (site scalars) and loadpoint_state (operational mode/target): this is the
    -- module-topology layer the reconcile seam rebuilds modules from.
    CREATE TABLE IF NOT EXISTS config_overrides (
      kind       TEXT NOT NULL,
      name       TEXT NOT NULL,
      patch      TEXT NOT NULL,
      origin     TEXT NOT NULL DEFAULT 'runtime',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (kind, name)
    );

    -- Runtime log ring buffer, auto-rotated by age (settings 'logs.retention_days', default 3) with a
    -- hard row-cap backstop. Captured from the single pino instance (all core + modules) plus a console
    -- tee for non-conforming plugins; queried newest-first by GET /api/logs. Pure runtime, never seeded.
    CREATE TABLE IF NOT EXISTS logs (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      time   TEXT NOT NULL,   -- ISO 8601 UTC (sorts chronologically = by insert order)
      level  TEXT NOT NULL,   -- 'debug' | 'info' | 'warn' | 'error'
      module TEXT,            -- best-effort component label (nullable)
      msg    TEXT NOT NULL,
      fields TEXT,            -- JSON of remaining structured context (nullable)
      err    TEXT             -- stack / error string when present (nullable)
    );
    CREATE INDEX IF NOT EXISTS idx_logs_time ON logs (time);
  `)

  // Additive migrations for pre-existing DBs — `CREATE TABLE IF NOT EXISTS` won't add a
  // column to an already-created table.
  addColumnIfMissing(db, 'transactions', 'meter_start', 'REAL')
  addColumnIfMissing(db, 'loadpoint_state', 'target_kwh', 'REAL')
  addColumnIfMissing(db, 'loadpoint_state', 'min_soc', 'REAL')
  // Per-session vehicle override ('guest' | a vehicle name; NULL = auto-detect). Sticky per session.
  addColumnIfMissing(db, 'loadpoint_state', 'guest_override', 'TEXT')
  // Vehicle-scoped plans: which vehicles a plan targets (JSON array; NULL/'[]' = any), and whether
  // reaching its target pauses charging (default ON; the Guest default plan is OFF). Existing rows get
  // NULL → treated as catch-all + pause-ON in rowToPlan.
  addColumnIfMissing(db, 'charge_plans', 'target_vehicles', 'TEXT')
  addColumnIfMissing(db, 'charge_plans', 'pause_on_target', 'INTEGER')
  // Persist the car's own target/plug/climate so the SessionReconciler's carAtTarget + plug guards
  // aren't blind for a poll after a restart (they were undefined until the first live refresh).
  addColumnIfMissing(db, 'vehicle_cache', 'target_soc', 'REAL')
  addColumnIfMissing(db, 'vehicle_cache', 'plugged_in', 'INTEGER')
  addColumnIfMissing(db, 'vehicle_cache', 'climate_active', 'INTEGER')
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}
