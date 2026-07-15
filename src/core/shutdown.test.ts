import { test, expect } from 'vitest'
import type { Logger } from 'pino'
import { gracefulShutdown, createSignalShutdown, type ShutdownContext } from './shutdown.js'

// A logger that records warn/error payloads (info is noise). Cast through unknown — gracefulShutdown
// only ever calls these three.
function recordingLogger() {
  const warns: unknown[] = []
  const errors: unknown[] = []
  const log = {
    info: () => {},
    warn: (o: unknown) => warns.push(o),
    error: (o: unknown) => errors.push(o),
  } as unknown as Logger
  return { log, warns, errors }
}

interface Overrides {
  ocppClose?: () => Promise<void>
  mqttStop?: () => Promise<void>
  moduleStops?: Array<() => Promise<void> | void>
  dbExec?: (sql: string) => void
  dbClose?: () => void
}

// Build a ShutdownContext of fakes that record into the shared `calls` array (so tests can assert
// sequencing), plus direct handles to the http + db fakes for state assertions.
function fakeCtx(calls: string[], over: Overrides = {}) {
  const http = {
    closeCalled: false,
    allConnsClosed: false,
    close(cb?: (e?: Error) => void) {
      http.closeCalled = true
      calls.push('http.close')
      cb?.()
    },
    closeAllConnections() {
      http.allConnsClosed = true
    },
  }
  const db = {
    execs: [] as string[],
    closed: false,
    exec(sql: string) {
      db.execs.push(sql)
      calls.push('db.exec')
      over.dbExec?.(sql)
    },
    close() {
      calls.push('db.close')
      if (over.dbClose) over.dbClose()
      else db.closed = true
    },
  }
  const modules = (over.moduleStops ?? []).map((stop, i) => ({
    stop: () => {
      calls.push(`mod${i}`)
      return stop()
    },
  }))
  // A real (long) timer, so the clear-timers path runs against a valid handle; gracefulShutdown clears
  // it up-front (even in the hung-teardown case), so it never lingers past the test.
  const timer = setTimeout(() => {}, 60_000)
  const ctx: ShutdownContext = {
    timers: [timer, undefined],
    httpServer: http,
    ocppServer: over.ocppClose ? { close: over.ocppClose } : undefined,
    mqttBridge: over.mqttStop ? { stop: over.mqttStop } : undefined,
    modules,
    db,
  }
  return { ctx, http, db }
}

test('drains connections + modules, then checkpoints the WAL and closes the db (in order)', async () => {
  const calls: string[] = []
  const { log } = recordingLogger()
  const { ctx, http, db } = fakeCtx(calls, {
    ocppClose: async () => void calls.push('ocpp'),
    mqttStop: async () => void calls.push('mqtt'),
    moduleStops: [async () => {}, async () => {}],
  })

  await gracefulShutdown(ctx, log)

  expect(http.closeCalled).toBe(true)
  expect(http.allConnsClosed).toBe(true) // force-drops OCPP/SSE sockets so close() resolves
  expect(calls).toContain('ocpp')
  expect(calls).toContain('mqtt')
  expect(calls).toContain('mod0')
  expect(calls).toContain('mod1')
  expect(db.execs).toEqual(['PRAGMA wal_checkpoint(TRUNCATE)'])
  expect(db.closed).toBe(true)
  // checkpoint runs AFTER the module drain, and close AFTER the checkpoint
  expect(calls.indexOf('db.exec')).toBeGreaterThan(calls.indexOf('mod0'))
  expect(calls.indexOf('db.exec')).toBeGreaterThan(calls.indexOf('mod1'))
  expect(calls.indexOf('db.close')).toBeGreaterThan(calls.indexOf('db.exec'))
})

test('a rejecting module stop does not abort the other teardowns or the WAL checkpoint', async () => {
  const calls: string[] = []
  const { log, warns } = recordingLogger()
  const { ctx, db } = fakeCtx(calls, {
    moduleStops: [
      async () => {
        throw new Error('boom')
      },
      async () => void calls.push('survivor'),
    ],
  })

  await expect(gracefulShutdown(ctx, log)).resolves.toBeUndefined()
  expect(calls).toContain('survivor') // the other module still ran
  expect(db.execs).toEqual(['PRAGMA wal_checkpoint(TRUNCATE)']) // still checkpointed
  expect(db.closed).toBe(true)
  expect(warns.length).toBeGreaterThan(0) // the failure was logged, not thrown
})

test('a throwing db.close is caught and logged, not propagated', async () => {
  const calls: string[] = []
  const { log, errors } = recordingLogger()
  const { ctx } = fakeCtx(calls, {
    moduleStops: [async () => {}],
    dbClose: () => {
      throw new Error('unfinalized statements')
    },
  })

  await expect(gracefulShutdown(ctx, log)).resolves.toBeUndefined()
  expect(errors.length).toBeGreaterThan(0)
})

test('createSignalShutdown runs the drain once and exits 0 (idempotent to a second signal)', async () => {
  const calls: string[] = []
  const { log } = recordingLogger()
  const exits: number[] = []
  const { ctx, db } = fakeCtx(calls, { moduleStops: [async () => void calls.push('stop')] })

  const shutdown = createSignalShutdown(ctx, log, { exit: (c) => exits.push(c), timeoutMs: 5000 })
  await shutdown('SIGTERM')
  await shutdown('SIGINT') // second signal ignored

  expect(calls.filter((c) => c === 'stop')).toHaveLength(1)
  expect(db.execs).toEqual(['PRAGMA wal_checkpoint(TRUNCATE)'])
  expect(exits).toEqual([0])
})

test('createSignalShutdown watchdog forces exit(1) when a teardown hangs', async () => {
  const calls: string[] = []
  const { log } = recordingLogger()
  const exits: number[] = []
  // A module whose stop never resolves → the drain hangs; only the watchdog can end it.
  const { ctx } = fakeCtx(calls, { moduleStops: [() => new Promise<void>(() => {})] })

  const shutdown = createSignalShutdown(ctx, log, { exit: (c) => exits.push(c), timeoutMs: 20 })
  void shutdown('SIGTERM') // do NOT await — it hangs on the never-resolving stop
  await new Promise((r) => setTimeout(r, 60)) // let the 20ms watchdog fire

  expect(exits).toContain(1)
})
