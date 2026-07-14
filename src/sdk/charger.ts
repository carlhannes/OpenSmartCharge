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
}

export interface Charger extends ModuleLifecycle {
  readonly id: string
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
