import type { ModuleHealth, ModuleLifecycle } from './types.js'

export interface MeterSnapshot {
  /** Instantaneous total active power, watts. Positive = importing from grid. */
  powerW?: number
  /** Per-phase currents, amps. */
  i1A?: number
  i2A?: number
  i3A?: number
  /** When this snapshot was produced by the reader. */
  timestamp: Date
}

export interface MeterReader extends ModuleLifecycle {
  readonly id: string
  start(): Promise<void>
  stop(): Promise<void>
  health(): ModuleHealth
  /** Last known snapshot, or null if no frame has been seen yet. */
  latest(): MeterSnapshot | null
  /** Subscribe to every new snapshot. Returns an unsubscribe function. */
  onSnapshot(cb: (s: MeterSnapshot) => void): () => void
}

export interface MeterReaderModule {
  readonly type: string
  create(cfg: unknown, ctx: import('./types.js').ModuleCtx): MeterReader
}
