import type { DatabaseSync } from 'node:sqlite'
import type { ChargeMode } from './config.js'

export interface LoadpointState {
  name: string
  mode: ChargeMode
  targetSoc?: number
  targetTime?: string
  connected: boolean
  charging: boolean
  currentA: number
  sessionEnergyKWh: number
  /** Config-derived ceiling, not persisted */
  maxCurrentA: number
  /** Whether to auto-start a transaction on plug-in */
  autoStart: boolean
}

interface DbRow {
  name: string
  mode: ChargeMode
  target_soc: number | null
  target_time: string | null
}

export interface LoadpointInit {
  name: string
  maxCurrentA?: number
  autoStart?: boolean
}

export function loadLoadpointStates(
  db: DatabaseSync,
  inits: LoadpointInit[],
): Map<string, LoadpointState> {
  const insert = db.prepare(`INSERT OR IGNORE INTO loadpoint_state (name, mode) VALUES (?, 'smart')`)
  const read = db.prepare(`SELECT * FROM loadpoint_state WHERE name = ?`)

  const states = new Map<string, LoadpointState>()
  for (const { name, maxCurrentA = 16, autoStart = true } of inits) {
    insert.run(name)
    const row = read.get(name) as unknown as DbRow
    states.set(name, {
      name,
      mode: row.mode,
      targetSoc: row.target_soc ?? undefined,
      targetTime: row.target_time ?? undefined,
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
  db
    .prepare(`UPDATE loadpoint_state SET mode = ?, updated_at = datetime('now') WHERE name = ?`)
    .run(mode, name)
}

export function setLoadpointTarget(
  db: DatabaseSync,
  name: string,
  targetSoc?: number,
  targetTime?: string,
): void {
  db
    .prepare(
      `UPDATE loadpoint_state SET target_soc = ?, target_time = ?, updated_at = datetime('now') WHERE name = ?`,
    )
    .run(targetSoc ?? null, targetTime ?? null, name)
}
