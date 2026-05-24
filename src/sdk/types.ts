import type { DatabaseSync } from 'node:sqlite'
import type { EventEmitter } from 'node:events'
import type { Logger } from 'pino'

export type ModuleHealth = 'ok' | 'degraded' | 'unavailable'

export interface ModuleCtx {
  db: DatabaseSync
  events: EventEmitter
  log: Logger
  /**
   * Drop-in replacement for the global `fetch()`.
   * Adds a random 0–120 s jitter before each request so that all running
   * OSC instances don't hit the same external endpoint at the same millisecond
   * when a scheduled task fires (thundering-herd prevention).
   *
   * Use this for all scheduled/periodic outbound HTTP calls. For startup
   * fetches where you need an immediate response, use the global `fetch`.
   */
  fetch: typeof globalThis.fetch
  /**
   * MQTT broker connection parameters. Populated when `mqtt:` is configured
   * in osc.yaml. Modules that need MQTT should open their own client using
   * these params — the OSC bridge's client is reserved for OSC's own topics.
   * Undefined when MQTT is not configured.
   */
  mqtt?: { host: string; port: number; user?: string; password?: string }
}
