import type { ModuleCtx, ModuleHealth, ModuleLifecycle } from './types.js'

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
  /** Amps available for the whole circuit this tick — already resolved through the degradation
   *  ladder (live-meter headroom / historical worst-case / static time-of-day) by the lifecycle.
   *  The balancer SPLITS this across loadpoints; it never reads the meter or computes headroom. */
  circuitBudgetA: number
  timestamp: Date
}

export interface BalancerOutput {
  allocations: Map<string, number>
}

export interface Balancer extends ModuleLifecycle {
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
