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
  /** Last known snapshot, or null if no frame has been seen yet. Live frames are announced on the
   *  event bus as `meter.snapshot` ({ name, snapshot }) — that is the one fan-out path. */
  latest(): MeterSnapshot | null
}

/**
 * The one staleness rule for meter readers: `ok` while frames arrive within `staleAfterSec`,
 * `degraded` once the last frame is older (the last values are still served), `unavailable` before
 * the first frame. The reader's health is the single authority the current-budget ladder trusts.
 */
export function meterHealth(
  latest: MeterSnapshot | null,
  staleAfterSec: number,
  nowMs = Date.now(),
): ModuleHealth {
  if (!latest) return 'unavailable'
  return nowMs - latest.timestamp.getTime() < staleAfterSec * 1000 ? 'ok' : 'degraded'
}

export interface MeterReaderModule {
  readonly type: string
  create(cfg: unknown, ctx: import('./types.js').ModuleCtx): MeterReader
}
