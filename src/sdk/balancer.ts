import type { ModuleCtx, ModuleHealth } from './types.js'

export type ChargeMode = 'disabled' | 'smart' | 'fast'

export interface LoadpointSnapshot {
  id: string
  mode: ChargeMode
  connected: boolean
  charging: boolean
  currentA: number
  sessionEnergyKWh: number
  estimatedSoc?: number
  targetSoc?: number
  targetTime?: Date
  pricesAvailable: boolean
}

export interface BalancerInput {
  loadpoints: LoadpointSnapshot[]
  timestamp: Date
}

export interface BalancerOutput {
  allocations: Map<string, number>
}

export interface Balancer {
  readonly id: string
  health(): ModuleHealth
  tick(input: BalancerInput): Promise<BalancerOutput>
}

export interface BalancerModule {
  readonly type: string
  create(cfg: unknown, ctx: ModuleCtx): Balancer
}
