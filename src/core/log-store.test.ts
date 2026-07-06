import { test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from './db.js'
import {
  insertLog,
  queryLogs,
  pruneLogs,
  bucketLevel,
  pinoRecordToLog,
  createLogCaptureStream,
  patchConsole,
  exportLogsText,
  formatLogLine,
  type LogRecord,
} from './log-store.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'osc-logs-'))
  dirs.push(dir)
  return openDb(dir)
}

const rec = (over: Partial<LogRecord> = {}): LogRecord => ({
  time: '2026-07-06T10:00:00.000Z',
  level: 'info',
  module: null,
  msg: 'hello',
  fields: null,
  err: null,
  ...over,
})

// ── pino record → row mapping ──────────────────────────────────────────────────────────────────
test('bucketLevel maps pino numeric levels to the 4 buckets', () => {
  expect(bucketLevel(10)).toBe('debug') // trace
  expect(bucketLevel(20)).toBe('debug')
  expect(bucketLevel(30)).toBe('info')
  expect(bucketLevel(40)).toBe('warn')
  expect(bucketLevel(50)).toBe('error')
  expect(bucketLevel(60)).toBe('error') // fatal
  expect(bucketLevel(undefined)).toBe('info') // missing → info default
})

test('pinoRecordToLog: level, ISO time, module + fields split, err serialization', () => {
  const r = pinoRecordToLog({
    level: 20,
    time: 1751796000000,
    msg: 'circuit resolve',
    loadpoint: 'garage',
    budgetA: 16,
    pid: 123,
    hostname: 'pi',
    v: 1,
  })
  expect(r.level).toBe('debug')
  expect(r.time).toBe(new Date(1751796000000).toISOString())
  expect(r.msg).toBe('circuit resolve')
  expect(r.module).toBe('loadpoint:garage') // lifted from the ad-hoc key
  expect(r.fields).toEqual({ loadpoint: 'garage', budgetA: 16 }) // pino framing stripped, context kept
  expect(r.err).toBeNull()
})

test('pinoRecordToLog: err from {stack} / string / message; explicit module wins; empty fields → null', () => {
  expect(
    pinoRecordToLog({ level: 50, msg: 'x', err: { stack: 'Error: boom\n at z' } }).err,
  ).toContain('boom')
  expect(pinoRecordToLog({ level: 50, msg: 'x', err: 'plain' }).err).toBe('plain')
  expect(pinoRecordToLog({ level: 50, msg: 'x', err: { message: 'only-msg' } }).err).toBe(
    'only-msg',
  )
  expect(pinoRecordToLog({ level: 40, msg: 'x', module: 'custom', charger: 'go' }).module).toBe(
    'custom',
  )
  expect(pinoRecordToLog({ level: 30, msg: 'x' }).fields).toBeNull()
})

// ── insert + query ───────────────────────────────────────────────────────────────────────────────
test('queryLogs returns newest-first and omits empty module/fields/err', () => {
  const db = freshDb()
  insertLog(db, rec({ msg: 'first', time: '2026-07-06T10:00:00.000Z' }))
  insertLog(db, rec({ msg: 'second', time: '2026-07-06T10:01:00.000Z' }))
  const rows = queryLogs(db)
  expect(rows.map((r) => r.msg)).toEqual(['second', 'first']) // id DESC
  expect(rows[0].module).toBeUndefined()
  expect(rows[0].fields).toBeUndefined()
  expect(rows[0].err).toBeUndefined()
})

test('queryLogs level is a MINIMUM severity (warn → warn+error only)', () => {
  const db = freshDb()
  for (const level of ['debug', 'info', 'warn', 'error'] as const)
    insertLog(db, rec({ level, msg: level }))
  expect(new Set(queryLogs(db, { level: 'warn' }).map((r) => r.level))).toEqual(
    new Set(['warn', 'error']),
  )
  expect(queryLogs(db, { level: 'debug' })).toHaveLength(4) // floor = all
})

test('queryLogs since/until filter on time', () => {
  const db = freshDb()
  insertLog(db, rec({ msg: 'a', time: '2026-07-06T09:00:00.000Z' }))
  insertLog(db, rec({ msg: 'b', time: '2026-07-06T10:00:00.000Z' }))
  insertLog(db, rec({ msg: 'c', time: '2026-07-06T11:00:00.000Z' }))
  expect(queryLogs(db, { since: '2026-07-06T10:00:00.000Z' }).map((r) => r.msg)).toEqual(['c', 'b'])
  expect(queryLogs(db, { until: '2026-07-06T10:00:00.000Z' }).map((r) => r.msg)).toEqual(['b', 'a'])
})

test('queryLogs q is a literal substring on msg + module (LIKE metachars escaped)', () => {
  const db = freshDb()
  insertLog(db, rec({ msg: 'circuit resolve', module: 'loadpoint:garage' }))
  insertLog(db, rec({ msg: 'tariff prices updated', module: 'tariff:spot' }))
  insertLog(db, rec({ msg: '100% charged' }))
  expect(queryLogs(db, { q: 'circuit' }).map((r) => r.msg)).toEqual(['circuit resolve']) // msg hit
  expect(queryLogs(db, { q: 'garage' }).map((r) => r.msg)).toEqual(['circuit resolve']) // module hit
  expect(queryLogs(db, { q: '100%' }).map((r) => r.msg)).toEqual(['100% charged']) // % is literal
  expect(queryLogs(db, { q: 'nomatch' })).toHaveLength(0)
})

test('queryLogs limit defaults to 200 and is capped at 500', () => {
  const db = freshDb()
  for (let i = 0; i < 501; i++) insertLog(db, rec({ msg: `m${i}` }))
  expect(queryLogs(db, { limit: 2 })).toHaveLength(2)
  expect(queryLogs(db)).toHaveLength(200) // default
  expect(queryLogs(db, { limit: 1000 })).toHaveLength(500) // cap
})

test('insertLog round-trips fields (JSON) and err', () => {
  const db = freshDb()
  insertLog(
    db,
    rec({ msg: 'oops', level: 'error', fields: { code: 'E', attempt: 2 }, err: 'stack…' }),
  )
  const [row] = queryLogs(db)
  expect(row.fields).toEqual({ code: 'E', attempt: 2 })
  expect(row.err).toBe('stack…')
})

// ── prune ────────────────────────────────────────────────────────────────────────────────────────
test('pruneLogs drops rows older than retentionDays', () => {
  const db = freshDb()
  const old = new Date(Date.now() - 5 * 86400_000).toISOString()
  const nowIso = new Date().toISOString()
  insertLog(db, rec({ msg: 'old', time: old }))
  insertLog(db, rec({ msg: 'recent', time: nowIso }))
  pruneLogs(db, 3)
  expect(queryLogs(db).map((r) => r.msg)).toEqual(['recent'])
})

test('pruneLogs enforces the row-cap backstop (keeps newest N)', () => {
  const db = freshDb()
  for (let i = 0; i < 10; i++) insertLog(db, rec({ msg: `m${i}` }))
  pruneLogs(db, 9999, 5) // retention huge → age no-op; cap keeps newest 5
  const rows = queryLogs(db)
  expect(rows).toHaveLength(5)
  expect(rows.map((r) => r.msg)).toEqual(['m9', 'm8', 'm7', 'm6', 'm5'])
})

// ── capture stream + console tee ───────────────────────────────────────────────────────────────
test('createLogCaptureStream parses NDJSON, buffers partial writes, maps level/err', () => {
  const db = freshDb()
  const stream = createLogCaptureStream(db)
  stream.write('{"level":30,"time":1751796000000,"msg":"line one"}\n')
  stream.write('{"level":50,"time":1751796001000,"msg":"line ') // partial line
  stream.write('two","err":{"stack":"Error: x\\n at y"}}\n')
  const rows = queryLogs(db)
  expect(rows.map((r) => r.msg)).toEqual(['line two', 'line one'])
  expect(rows[0].level).toBe('error')
  expect(rows[0].err).toContain('Error: x')
  expect(rows[1].level).toBe('info')
})

test('patchConsole tees console.* into the store and restore() undoes it', () => {
  const db = freshDb()
  const restore = patchConsole(db)
  console.log('hello from plugin', { a: 1 })
  console.error('boom')
  restore()
  console.log('after restore — not captured')
  const rows = queryLogs(db)
  expect(rows).toHaveLength(2)
  const byMsg = Object.fromEntries(rows.map((r) => [r.msg, r.level]))
  expect(byMsg['hello from plugin { a: 1 }']).toBe('info')
  expect(byMsg['boom']).toBe('error')
})

// ── export (.log text) ─────────────────────────────────────────────────────────────────────────
test('formatLogLine renders a .log line; level column padded; err stack indented', () => {
  expect(
    formatLogLine({ id: 1, time: '2026-07-06T10:00:00.000Z', level: 'info', msg: 'ready' }),
  ).toBe(
    '2026-07-06T10:00:00.000Z INFO  ready', // INFO padded to 5 → two spaces before msg
  )
  expect(
    formatLogLine({
      id: 2,
      time: 'T',
      level: 'debug',
      module: 'loadpoint:garage',
      msg: 'circuit resolve',
      fields: { budgetA: 8 },
    }),
  ).toBe('T DEBUG [loadpoint:garage] circuit resolve {"budgetA":8}')
  expect(
    formatLogLine({ id: 3, time: 'T', level: 'error', msg: 'boom', err: 'Error: boom\n at z' }),
  ).toBe('T ERROR boom\n    Error: boom\n     at z')
})

test('exportLogsText: chronological (oldest-first), filtered, trailing newline; empty → ""', () => {
  const db = freshDb()
  insertLog(db, rec({ msg: 'a', level: 'info', time: '2026-07-06T09:00:00.000Z' }))
  insertLog(db, rec({ msg: 'b', level: 'error', module: 'ocpp', time: '2026-07-06T10:00:00.000Z' }))
  insertLog(db, rec({ msg: 'c', level: 'debug', time: '2026-07-06T11:00:00.000Z' }))
  const all = exportLogsText(db)
  expect(
    all
      .trimEnd()
      .split('\n')
      .map((l) => l.slice(0, 30)),
  ).toEqual([
    '2026-07-06T09:00:00.000Z INFO ', // oldest first (id ASC), opposite of the viewer
    '2026-07-06T10:00:00.000Z ERROR',
    '2026-07-06T11:00:00.000Z DEBUG',
  ])
  expect(all.endsWith('\n')).toBe(true)
  expect(exportLogsText(db, { level: 'error' }).trimEnd().split('\n')).toHaveLength(1) // level floor
  expect(exportLogsText(db, { q: 'ocpp' }).trimEnd()).toContain('[ocpp] b') // q on module
  expect(exportLogsText(db, { q: 'zzz-nomatch' })).toBe('') // empty → no stray newline
})
