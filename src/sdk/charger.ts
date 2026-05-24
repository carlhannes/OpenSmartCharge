import type { ModuleCtx, ModuleHealth } from './types.js'

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

export interface Charger {
  readonly id: string
  start(): Promise<void>
  stop(): Promise<void>
  setCurrentLimit(amps: number): Promise<void>
  health(): ModuleHealth
  onStatus(cb: (status: ChargerStatus) => void): () => void
}

export interface ChargerModule {
  readonly type: string
  create(cfg: unknown, ctx: ModuleCtx): Charger
}
