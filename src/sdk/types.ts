import type { DatabaseSync } from 'node:sqlite'
import type { EventEmitter } from 'node:events'
import type { Logger } from 'pino'

export type ModuleHealth = 'ok' | 'degraded' | 'unavailable'

export interface ModuleCtx {
  db: DatabaseSync
  events: EventEmitter
  log: Logger
  /**
   * Jittered `fetch()` — sleeps a random 0–120 s before each request. Its ONLY purpose is to
   * spread load when many OSC instances would otherwise hit the same PUBLIC endpoint at the same
   * wall-clock instant (thundering-herd prevention) — e.g. day-ahead tariff prices fetched right
   * after their fixed publish time.
   *
   * Use it ONLY for public, non-time-sensitive, scheduled data (tariffs). Do NOT use it for
   * anything that needs a prompt answer — vehicle reads (poll on connect / during charging),
   * car↔charger detection, auth: those must use the plain global `fetch` so they return
   * immediately. When in doubt, use the global `fetch`.
   */
  fetch: typeof globalThis.fetch
}
