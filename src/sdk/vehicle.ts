import type { ModuleCtx, ModuleHealth } from './types.js'

export interface VehicleData {
  soc: number
  batteryCapacity?: number
  range?: number
  isCharging?: boolean
  /** Target state of charge the car is set to (%). */
  targetSoc?: number
  /** The car's own view of whether a cable is connected — a cross-check independent of OCPP. */
  pluggedIn?: boolean
  /** Remote climate / preconditioning currently running. */
  climateActive?: boolean
  /** Raw charging state enum (CHARGING | CONNECT_CABLE | READY_FOR_CHARGING | CONSERVING | …). */
  state?: string
  chargePowerKw?: number
  remainingChargeMinutes?: number
  fetchedAt: Date
}

export interface Vehicle {
  readonly id: string
  /**
   * Perform ONE live fetch, update the cache, and return the fresh data. The lifecycle decides
   * WHEN to call this (on charger-connect + periodically during charging) — the module owns no
   * background timer of its own. Throws on failure; the caller keeps the last cached value.
   */
  refresh(): Promise<VehicleData>
  /** Last cached data (throws if none fetched yet). Does not hit the network. */
  getData(): Promise<VehicleData>
  getCachedCapacity(): number | undefined
  health(): ModuleHealth
  stop(): Promise<void>
}

export interface VehicleModule {
  readonly type: string
  create(cfg: unknown, ctx: ModuleCtx): Vehicle
}
