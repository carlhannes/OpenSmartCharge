import type { ModuleCtx, ModuleHealth } from './types.js'

export interface VehicleData {
  soc: number
  batteryCapacity?: number
  range?: number
  isCharging?: boolean
  fetchedAt: Date
}

export interface Vehicle {
  readonly id: string
  start(): Promise<void>
  stop(): Promise<void>
  health(): ModuleHealth
  getData(): Promise<VehicleData>
  getCachedCapacity(): number | undefined
}

export interface VehicleModule {
  readonly type: string
  create(cfg: unknown, ctx: ModuleCtx): Vehicle
}
