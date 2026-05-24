import type { ModuleCtx, ModuleHealth } from './types.js'

export interface TariffSlot {
  start: Date
  end: Date
  pricePerKWh: number
  currency: string
}

export interface Tariff {
  readonly id: string
  health(): ModuleHealth
  prices(from: Date, to: Date): Promise<TariffSlot[]>
}

export interface TariffModule {
  readonly type: string
  create(cfg: unknown, ctx: ModuleCtx): Tariff
}
