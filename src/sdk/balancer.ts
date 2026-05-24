import type { ModuleCtx, ModuleHealth } from './types.js'

export type ChargeMode = 'disabled' | 'smart' | 'fast'

export interface LoadpointSnapshot {
  id: string
  mode: ChargeMode
  connected: boolean
  charging: boolean
  currentA: number
  /** Last amps value successfully sent to the charger via SetChargingProfile. Used by the allocator's
   *  credit-back calculation so that a car still ramping up to a newly commanded level is not
   *  under-credited, which would cause oscillation during the 5–30 s ramp period. */
  commandedA?: number
  sessionEnergyKWh: number
  estimatedSoc?: number
  targetSoc?: number
  targetTime?: Date
  pricesAvailable: boolean
  /** Per-loadpoint current ceiling derived from charger config. */
  maxCurrentA: number
  /** Set by lifecycle for smart-mode loadpoints: false = expensive slot, skip charging. Undefined = charge. */
  shouldChargeNow?: boolean
}

export interface BalancerInput {
  loadpoints: LoadpointSnapshot[]
  timestamp: Date
}

export interface BalancerOutput {
  allocations: Map<string, number>
  /** House headroom after charger credit-back, as computed from live phase currents. Populated
   *  by the balancer module so the lifecycle doesn't have to recompute it from partial data. */
  freeAmps?: number
}

export interface Balancer {
  readonly id: string
  start(): Promise<void>
  stop(): Promise<void>
  health(): ModuleHealth
  tick(input: BalancerInput): Promise<BalancerOutput>
}

export interface BalancerModule {
  readonly type: string
  create(cfg: unknown, ctx: ModuleCtx): Balancer
}
