import type { DatabaseSync } from 'node:sqlite'
import type { EventEmitter } from 'node:events'
import type { Logger } from 'pino'

export type ModuleHealth = 'ok' | 'degraded' | 'unavailable'

export interface ModuleCtx {
  db: DatabaseSync
  events: EventEmitter
  log: Logger
}

/**
 * Optional lifecycle callbacks the LIFECYCLE invokes on a module. The module still owns no timers or
 * scheduling — these are one-shot hooks the lifecycle drives, in the same category as `start()`/
 * `stop()`. Every module interface extends this so the hook is uniform across module types.
 */
export interface ModuleLifecycle {
  /**
   * Called ONCE by the lifecycle after the whole system is up (all modules started, HTTP server
   * listening, control loop + health sweep running). Re-observe/reconcile this module's external
   * world with reality after a (re)start — the in-memory view was just lost, and peers (the charger,
   * the car) may not re-announce their state on a bare reconnect. E.g. a vehicle re-polls the car so
   * an already-plugged car is detected even when the charger still reports the connector `Available`.
   *
   * ONE-SHOT: do NOT start a timer or ongoing loop here — ongoing cadence stays lifecycle-driven
   * (the control loop / `shouldPollVehicle`). Idempotent + best-effort; MAY THROW — the lifecycle
   * retries with capped backoff.
   */
  postStartup?(): Promise<void>
}
