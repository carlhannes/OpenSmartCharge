import type { ModuleCtx, ModuleHealth } from './types.js'

export interface TariffSlot {
  start: Date
  end: Date
  pricePerKWh: number
  currency: string
}

export interface Tariff {
  readonly id: string
  start(): Promise<void>
  stop(): Promise<void>
  health(): ModuleHealth
  prices(from: Date, to: Date): Promise<TariffSlot[]>
  /** Force an immediate fetch now, bypassing the schedule (manual recovery / `POST .../refresh`).
   *  Optional: a provider implements it if an out-of-band refetch makes sense. Best-effort — resolves
   *  after the attempt (which reschedules the normal cadence); never rejects on a fetch failure. */
  refresh?(): Promise<void>
}

export interface TariffModule {
  readonly type: string
  create(cfg: unknown, ctx: ModuleCtx): Tariff
}
