import type { DatabaseSync } from 'node:sqlite'
import type { ChargeMode } from './config.js'
import type { ChargerStatus } from '../sdk/charger.js'

export interface LoadpointState {
  name: string
  mode: ChargeMode
  targetSoc?: number
  targetTime?: string
  /** Fixed energy-to-add target (kWh) — energy fallback when no vehicle SoC is available. */
  targetKWh?: number
  connected: boolean
  charging: boolean
  currentA: number
  sessionEnergyKWh: number
  /** Config-derived ceiling, not persisted */
  maxCurrentA: number
  /** Whether to auto-start a transaction on plug-in */
  autoStart: boolean
}

/** The live, charger-driven subset of loadpoint state. */
export type LoadpointLiveFields = Pick<
  LoadpointState,
  'connected' | 'charging' | 'currentA' | 'sessionEnergyKWh'
>

/**
 * Fold a charger status update into the loadpoint's live fields.
 *
 * `currentA` and `sessionEnergyKWh` are sticky: a bare StatusNotification carries neither,
 * so we keep the last MeterValues reading rather than blanking the display between frames.
 * The exception is `currentA` when the charger isn't charging — a stopped or suspended
 * session draws no current, so it's forced to 0. Otherwise the last live value would stick
 * forever after StopTransaction (which pushes `charging:false` with no `currentA`).
 */
export function foldChargerStatus(
  prev: LoadpointLiveFields,
  status: ChargerStatus,
): LoadpointLiveFields {
  return {
    connected: status.connected,
    charging: status.charging,
    currentA: status.charging ? (status.currentA ?? prev.currentA) : 0,
    sessionEnergyKWh: status.sessionEnergyKWh ?? prev.sessionEnergyKWh,
  }
}

interface DbRow {
  name: string
  mode: ChargeMode
  target_soc: number | null
  target_time: string | null
  target_kwh: number | null
}

export interface LoadpointInit {
  name: string
  maxCurrentA?: number
  autoStart?: boolean
  defaultMode?: ChargeMode
  /** Config-provided targets, seeded into a NEW loadpoint's persisted row. */
  targetSoc?: number
  targetTime?: string
  targetKWh?: number
}

export function loadLoadpointStates(
  db: DatabaseSync,
  inits: LoadpointInit[],
): Map<string, LoadpointState> {
  // INSERT OR IGNORE: seed a new loadpoint with its configured defaultMode + targets; an
  // existing (persisted) row is left untouched, so a saved mode/target still wins on restart.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO loadpoint_state (name, mode, target_soc, target_time, target_kwh)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const read = db.prepare(`SELECT * FROM loadpoint_state WHERE name = ?`)

  const states = new Map<string, LoadpointState>()
  for (const init of inits) {
    const { name, maxCurrentA = 16, autoStart = true, defaultMode = 'smart' } = init
    insert.run(name, defaultMode, init.targetSoc ?? null, init.targetTime ?? null, init.targetKWh ?? null)
    const row = read.get(name) as unknown as DbRow
    states.set(name, {
      name,
      mode: row.mode,
      targetSoc: row.target_soc ?? undefined,
      targetTime: row.target_time ?? undefined,
      targetKWh: row.target_kwh ?? undefined,
      connected: false,
      charging: false,
      currentA: 0,
      sessionEnergyKWh: 0,
      maxCurrentA,
      autoStart,
    })
  }
  return states
}

export function setLoadpointMode(db: DatabaseSync, name: string, mode: ChargeMode): void {
  db.prepare(
    `UPDATE loadpoint_state SET mode = ?, updated_at = datetime('now') WHERE name = ?`,
  ).run(mode, name)
}

export function setLoadpointTarget(
  db: DatabaseSync,
  name: string,
  targetSoc?: number,
  targetTime?: string,
): void {
  db.prepare(
    `UPDATE loadpoint_state SET target_soc = ?, target_time = ?, updated_at = datetime('now') WHERE name = ?`,
  ).run(targetSoc ?? null, targetTime ?? null, name)
}
