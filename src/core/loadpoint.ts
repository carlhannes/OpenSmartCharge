import type { DatabaseSync } from 'node:sqlite'
import type { ChargeMode, Config } from './config.js'
import type { ChargerStatus } from '../sdk/charger.js'

export interface LoadpointState {
  name: string
  mode: ChargeMode
  targetSoc?: number
  targetTime?: string
  /** Fixed energy-to-add target (kWh) — energy fallback when no vehicle SoC is available. */
  targetKWh?: number
  /** Minimum SoC (%) safety floor — force-charge in smart mode when SoC drops below it. */
  minSoc?: number
  /** Per-session vehicle-presence override (persisted): 'guest' = force guest, 'vehicle' = force the
   * bound car; undefined = auto-detect. Reset on unplug. See smart-charging/guest.ts. */
  guestOverride?: 'guest' | 'vehicle'
  connected: boolean
  charging: boolean
  /** Raw OCPP connector status (Available/Preparing/Charging/SuspendedEV/…). Undefined until the
   * first status frame. The SessionReconciler needs this finer signal — `connected`/`charging`
   * booleans can't tell "idle" from "plugged-not-started" from "latched-suspended". */
  status?: ChargerStatus['status']
  currentA: number
  /** Instantaneous power draw (W) from MeterValues; 0 when not charging. */
  powerW: number
  sessionEnergyKWh: number
  /** Config-derived ceiling, not persisted */
  maxCurrentA: number
  /** Latest control-loop decision — the "why" behind charging/pausing. Resolver-derived,
   * recomputed each tick, not persisted; undefined until the first tick. `budgetA` is the CIRCUIT
   * budget (bare loadpoint = its own; balancer = the shared pool it splits). `shouldChargeNow` is a
   * SMART-mode decision only — undefined in fast (charges unconditionally) and disabled (never charges),
   * where `mode` itself is the "why"; consumers must read its absence as "mode decides", not false. */
  resolve?: {
    shouldChargeNow?: boolean
    budgetA: number
    sources: { energy: string; price: string; current: string }
  }
  /** Resolved vehicle present this session: the bound car's name, or null (guest). Resolver-derived,
   * recomputed each tick, not persisted; undefined until the first tick. See smart-charging/guest.ts. */
  activeVehicle?: string | null
  /** The current plug-in session has completed — a real SoC target was reached, or the car itself
   * stopped accepting charge after delivering energy. Recomputed each tick, not persisted; reset on
   * unplug. Silences the SessionReconciler and drives the UI "Ready" state. See
   * smart-charging/session-complete.ts. */
  sessionComplete?: boolean
  /** kWh delivered this plug-in, peak-held across the OCPP transaction churn that zeroes the live
   * `sessionEnergyKWh`. Tick-derived, not persisted; reset on unplug. The display total + the
   * "delivered something" gate for `sessionComplete`. */
  deliveredKWh?: number
}

/** The live, charger-driven subset of loadpoint state. */
export type LoadpointLiveFields = Pick<
  LoadpointState,
  'connected' | 'charging' | 'status' | 'currentA' | 'powerW' | 'sessionEnergyKWh'
>

/**
 * Fold a charger status update into the loadpoint's live fields.
 *
 * `currentA`/`powerW` and `sessionEnergyKWh` are sticky: a bare StatusNotification carries none,
 * so we keep the last MeterValues reading rather than blanking the display between frames.
 * The exception is `currentA`/`powerW` when the charger isn't charging — a stopped or suspended
 * session draws nothing, so they're forced to 0. Otherwise the last live value would stick
 * forever after StopTransaction (which pushes `charging:false` with no `currentA`/`powerW`).
 */
export function foldChargerStatus(
  prev: LoadpointLiveFields,
  status: ChargerStatus,
): LoadpointLiveFields {
  return {
    connected: status.connected,
    charging: status.charging,
    status: status.status,
    currentA: status.charging ? (status.currentA ?? prev.currentA) : 0,
    powerW: status.charging ? (status.powerW ?? prev.powerW) : 0,
    sessionEnergyKWh: status.sessionEnergyKWh ?? prev.sessionEnergyKWh,
  }
}

interface DbRow {
  name: string
  mode: ChargeMode
  target_soc: number | null
  target_time: string | null
  target_kwh: number | null
  min_soc: number | null
  guest_override: string | null
}

export interface LoadpointInit {
  name: string
  maxCurrentA?: number
  defaultMode?: ChargeMode
  /** Config-provided targets, seeded into a NEW loadpoint's persisted row. */
  targetSoc?: number
  targetTime?: string
  targetKWh?: number
  minSoc?: number
}

export function loadLoadpointStates(
  db: DatabaseSync,
  inits: LoadpointInit[],
): Map<string, LoadpointState> {
  // INSERT OR IGNORE: seed a new loadpoint with its configured defaultMode + targets; an
  // existing (persisted) row is left untouched, so a saved mode/target still wins on restart.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO loadpoint_state (name, mode, target_soc, target_time, target_kwh, min_soc)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const read = db.prepare(`SELECT * FROM loadpoint_state WHERE name = ?`)

  const states = new Map<string, LoadpointState>()
  for (const init of inits) {
    const { name, maxCurrentA = 16, defaultMode = 'smart' } = init
    insert.run(
      name,
      defaultMode,
      init.targetSoc ?? null,
      init.targetTime ?? null,
      init.targetKWh ?? null,
      init.minSoc ?? null,
    )
    const row = read.get(name) as unknown as DbRow
    states.set(name, {
      name,
      mode: row.mode,
      targetSoc: row.target_soc ?? undefined,
      targetTime: row.target_time ?? undefined,
      targetKWh: row.target_kwh ?? undefined,
      minSoc: row.min_soc ?? undefined,
      guestOverride: (row.guest_override as 'guest' | 'vehicle' | null) ?? undefined,
      connected: false,
      charging: false,
      currentA: 0,
      powerW: 0,
      sessionEnergyKWh: 0,
      maxCurrentA,
    })
  }
  return states
}

// Map the parsed config into loadpoint seed/init records (maxA comes from the referenced charger).
// Single-sourced so lifecycle boot and the config-apply CLI build identical inits.
export function configToLoadpointInits(config: Config): LoadpointInit[] {
  return config.loadpoints.map((lp) => {
    const chargerCfg = config.chargers.find((c) => c.name === lp.charger)
    return {
      name: lp.name,
      maxCurrentA: (chargerCfg as { maxA?: number } | undefined)?.maxA ?? 16,
      defaultMode: lp.defaultMode,
      targetSoc: lp.targetSoc,
      targetTime: lp.targetTime,
      targetKWh: lp.targetKWh,
      minSoc: lp.minSoc,
    }
  })
}

// Declaratively push config defaults (mode + targets) into loadpoint_state, OVERWRITING the
// persisted values. This is the deliberate escape hatch for the persist-wins boot semantics
// (loadLoadpointStates leaves existing rows untouched): the DB is the runtime source of truth, and
// this is how you re-assert osc.yaml onto it — run via the `config:apply` CLI, never on boot.
// Declarative: a target omitted in config is cleared (set to NULL), so the DB matches the file.
export function applyConfigToLoadpoints(db: DatabaseSync, inits: LoadpointInit[]): void {
  const upsert = db.prepare(
    `INSERT INTO loadpoint_state (name, mode, target_soc, target_time, target_kwh, min_soc)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       mode        = excluded.mode,
       target_soc  = excluded.target_soc,
       target_time = excluded.target_time,
       target_kwh  = excluded.target_kwh,
       min_soc     = excluded.min_soc,
       updated_at  = datetime('now')`,
  )
  for (const init of inits) {
    upsert.run(
      init.name,
      init.defaultMode ?? 'smart',
      init.targetSoc ?? null,
      init.targetTime ?? null,
      init.targetKWh ?? null,
      init.minSoc ?? null,
    )
  }
}

export function setLoadpointMode(db: DatabaseSync, name: string, mode: ChargeMode): void {
  db.prepare(
    `UPDATE loadpoint_state SET mode = ?, updated_at = datetime('now') WHERE name = ?`,
  ).run(mode, name)
}

// Partial update: an `undefined` field is left unchanged (COALESCE keeps the existing value), so
// setting one target — e.g. just `targetSoc` — doesn't NULL out the others. `targetKWh` additionally
// supports an explicit CLEAR: pass `null` to null the column (guest "just charge" = no kWh cap),
// distinct from `undefined` (leave as-is). soc/time/minSoc keep leave-or-set-only semantics.
export function setLoadpointTarget(
  db: DatabaseSync,
  name: string,
  targetSoc?: number,
  targetTime?: string,
  targetKWh?: number | null,
  minSoc?: number,
): void {
  db.prepare(
    `UPDATE loadpoint_state
       SET target_soc  = COALESCE(?, target_soc),
           target_time = COALESCE(?, target_time),
           target_kwh  = CASE WHEN ? THEN NULL ELSE COALESCE(?, target_kwh) END,
           min_soc     = COALESCE(?, min_soc),
           updated_at  = datetime('now')
     WHERE name = ?`,
  ).run(
    targetSoc ?? null,
    targetTime ?? null,
    targetKWh === null ? 1 : 0,
    typeof targetKWh === 'number' ? targetKWh : null,
    minSoc ?? null,
    name,
  )
}

// Set (or clear with `null`) the per-session guest override. Full replace — `null` returns to
// auto-detect. Runtime-only; the lifecycle resets it on unplug. See smart-charging/guest.ts.
export function setLoadpointGuestOverride(
  db: DatabaseSync,
  name: string,
  override: 'guest' | 'vehicle' | null,
): void {
  db.prepare(
    `UPDATE loadpoint_state SET guest_override = ?, updated_at = datetime('now') WHERE name = ?`,
  ).run(override, name)
}
