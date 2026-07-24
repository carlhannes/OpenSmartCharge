import type { ModuleCtx, ModuleHealth, ModuleLifecycle } from './types.js'

export interface ChargerStatus {
  connectorId: number
  status:
    | 'Available'
    | 'Preparing'
    | 'Charging'
    | 'SuspendedEVSE'
    | 'SuspendedEV'
    | 'Finishing'
    | 'Reserved'
    | 'Unavailable'
    | 'Faulted'
  connected: boolean
  charging: boolean
  currentA?: number
  powerW?: number
  sessionEnergyKWh?: number
  /** Charger-reported EV identity (VIN / EVCCID / RFID idTag) — OCPP 2.0 / ISO 15118. Unset by OCPP
   *  1.6; when present, the core matches it to a configured vehicle's declared identity (hard ID that
   *  beats vehicle-side presence polling). */
  evId?: string
  /** Charger-reported state of charge (%) — OCPP 2.0 / ISO 15118 (or a DC charger). Unset by 1.6. */
  socPct?: number
}

export interface Charger extends ModuleLifecycle {
  readonly id: string
  /** What this charger can report beyond power (OCPP 2.0 / ISO 15118 forward-compat). Absent = none
   *  (OCPP 1.6). When it reports SoC / an EV id, those flow via ChargerStatus (socPct / evId). */
  readonly capabilities?: { reportsSoC: boolean; reportsVehicleId: boolean }
  start(): Promise<void>
  stop(): Promise<void>
  setCurrentLimit(amps: number): Promise<void>
  remoteStart?(idTag?: string): Promise<void>
  remoteStop?(): Promise<void>
  setOneShotProfile?(amps: number): Promise<void>
  reset?(type?: 'Soft' | 'Hard'): Promise<void>
  clearChargingProfile?(): Promise<{ status?: string }>
  getCompositeSchedule?(durationSec?: number): Promise<unknown>
  health(): ModuleHealth
  onStatus(cb: (status: ChargerStatus) => void): () => void
}

export interface ChargerModule {
  readonly type: string
  create(cfg: unknown, ctx: ModuleCtx): Charger
}
