import pino from 'pino'
import type { Writable } from 'node:stream'

/**
 * The single app-wide logger. Everything (core + lifecycle + every module via ctx.log) shares this
 * instance, so passing capture streams here persists all of it (see core/log-store.ts).
 *
 * With capture streams present, the base level drops to `trace` and each capture leg runs at `trace`
 * so debug/trace records actually reach it (at `info` they were filtered before any stream saw them) —
 * but the stdout leg stays at `LOG_LEVEL` (default `info`), so operator console noise is unchanged.
 * `LOG_LEVEL` now governs only the console; the DB always captures everything. With no capture streams
 * (tests) it's the plain single-stream logger it always was.
 */
export const createLogger = (captureStreams: Writable[] = []): pino.Logger => {
  const consoleLevel = (process.env.LOG_LEVEL ?? 'info') as pino.Level
  if (captureStreams.length === 0) return pino({ level: consoleLevel })
  return pino(
    { level: 'trace' },
    pino.multistream([
      { level: consoleLevel, stream: process.stdout },
      ...captureStreams.map((stream) => ({ level: 'trace' as pino.Level, stream })),
    ]),
  )
}

export type Logger = pino.Logger
