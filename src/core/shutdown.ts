import type { Logger } from 'pino'

// Graceful shutdown, extracted from lifecycle.ts so it can be unit-tested WITHOUT importing lifecycle
// (which self-invokes main() at module load). All types here are structural on purpose — this module
// stays decoupled from node:http / node:sqlite / the OCPP server, so the tests can drive it with fakes.

/** Hard ceiling on graceful shutdown. Whatever a teardown step does, the process exits within this
 *  bound — the anti-hang guarantee that stops us ever needing a SIGKILL again. Kept under a typical
 *  supervisor kill grace (Docker 10 s, systemd 90 s) so we drain cleanly but are never force-killed. */
export const SHUTDOWN_TIMEOUT_MS = 8000

/** Minimal http.Server surface we need. */
interface ClosableServer {
  close(cb?: (err?: Error) => void): unknown
  /** Node 18.2+ — force-drops keep-alive + SSE sockets so close() can actually resolve. */
  closeAllConnections?(): void
}

/** Minimal node:sqlite DatabaseSync surface. */
interface CheckpointableDb {
  exec(sql: string): void
  close(): void
}

export interface ShutdownContext {
  /** Intervals + the post-startup timeout. Cleared first so no new work starts mid-drain.
   *  (clearInterval clears timeouts too in Node — the handles are interchangeable.) */
  timers: Array<ReturnType<typeof setTimeout> | undefined>
  httpServer: ClosableServer
  ocppServer: { close(): Promise<void> } | undefined
  mqttBridge: { stop(): Promise<void> } | undefined
  /** Every live module (balancers, vehicles, tariffs, meter readers) — the shared stop() convention. */
  modules: Array<{ stop(): Promise<void> | void }>
  db: CheckpointableDb
}

/** Stop the HTTP server: stop listening AND force-close live sockets (OCPP upgrades, SSE keep-alives)
 *  that would otherwise keep close() pending forever. Resolves once close() fires. */
export function closeHttp(server: ClosableServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}

/** Drain every long-lived resource, then checkpoint + close the DB. Awaitable and side-effect-only — it
 *  does NOT call process.exit (the signal wrapper owns that + the watchdog), which keeps it unit-testable.
 *  Never throws: connection/module failures are collected (allSettled) and logged; the DB step is guarded. */
export async function gracefulShutdown(ctx: ShutdownContext, log: Logger): Promise<void> {
  // 1. Stop timers first — no new control ticks / health sweeps / polls during teardown.
  for (const t of ctx.timers) if (t) clearInterval(t)

  // 2. Drain connections + modules concurrently. allSettled: one failing stop() must not strand the rest.
  const drain: Array<Promise<unknown>> = [closeHttp(ctx.httpServer)]
  if (ctx.ocppServer) drain.push(ctx.ocppServer.close())
  if (ctx.mqttBridge) drain.push(ctx.mqttBridge.stop())
  for (const m of ctx.modules) drain.push(Promise.resolve(m.stop()))
  const results = await Promise.allSettled(drain)
  for (const r of results) {
    if (r.status === 'rejected') log.warn({ err: r.reason }, 'shutdown: a teardown step failed')
  }

  // 3. Flush the WAL into osc.db + truncate it, then close. node:sqlite has no checkpoint API — SQL is
  //    the way; db.close() is synchronous and throws (not hangs) on open statements, so guard both.
  try {
    ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    ctx.db.close()
  } catch (err) {
    log.error({ err }, 'shutdown: WAL checkpoint / db close failed')
  }
}

/** Build a signal handler around gracefulShutdown: idempotent (a second signal mid-teardown is ignored)
 *  and watchdog-guarded — it forces exit within `timeoutMs` even if a teardown step hangs, which is the
 *  anti-hang guarantee that means a restart never needs a SIGKILL. On success it exits 0 after the drain.
 *  `exit` + `timeoutMs` are injectable so this is unit-testable; prod uses process.exit + the default. */
export function createSignalShutdown(
  ctx: ShutdownContext,
  log: Logger,
  opts: { exit?: (code: number) => void; timeoutMs?: number } = {},
): (signal: string) => Promise<void> {
  const exit: (code: number) => void = opts.exit ?? process.exit
  const timeoutMs = opts.timeoutMs ?? SHUTDOWN_TIMEOUT_MS
  let shuttingDown = false
  return async (signal: string): Promise<void> => {
    if (shuttingDown) return // a second signal during teardown is ignored
    shuttingDown = true
    log.info({ signal }, 'shutting down gracefully')
    const watchdog = setTimeout(() => {
      log.error({ timeoutMs }, 'graceful shutdown timed out — forcing exit')
      exit(1)
    }, timeoutMs)
    watchdog.unref() // the watchdog itself must not keep the event loop alive
    await gracefulShutdown(ctx, log)
    clearTimeout(watchdog)
    log.info('shutdown complete')
    exit(0)
  }
}
