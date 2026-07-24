// Runtime log store: capture (pino stream leg + console tee) → sqlite `logs` table → queryable GET.
// The whole app funnels through one pino instance (createLogger, passed to every module via ctx.log),
// so a single capture stream on it persists core + lifecycle + all modules with structure. A console
// tee is the safety net for plugins that ignore ctx.log and just console.log. Mirrors the transactions
// pattern (persist like insertMeterValues; query like GET /api/transactions). See docs/ui2-logs-handoff.md.
import type { DatabaseSync } from 'node:sqlite'
import { Writable } from 'node:stream'
import { format as formatArgs } from 'node:util'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** A row as returned to the API (newest-first). `fields`/`err`/`module` omitted when empty. */
export interface LogEntry {
  id: number
  time: string // ISO 8601
  level: LogLevel
  module?: string
  msg: string
  fields?: Record<string, unknown>
  err?: string
}

/** A record ready to persist (pre-id). Nulls for the absent optional columns. */
export interface LogRecord {
  time: string
  level: LogLevel
  module: string | null
  msg: string
  fields: Record<string, unknown> | null
  err: string | null
}

const LEVEL_ORDER: LogLevel[] = ['debug', 'info', 'warn', 'error']

// Insert order == chronological, so id DESC is newest-first without a time index scan.
export function insertLog(db: DatabaseSync, rec: LogRecord): void {
  try {
    db.prepare(
      `INSERT INTO logs (time, level, module, msg, fields, err) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      rec.time,
      rec.level,
      rec.module,
      rec.msg,
      rec.fields ? JSON.stringify(rec.fields) : null,
      rec.err,
    )
  } catch {
    // Logging must never crash the app (e.g. the DB is closed mid-shutdown). Swallow.
  }
}

// ── pino record → LogRecord ──────────────────────────────────────────────────────────────────────
// pino writes newline-delimited JSON: numeric `level` (10 trace…60 fatal), epoch-ms `time`, `msg`, a
// serialized `err` ({type,message,stack}), plus ad-hoc context keys.

/** pino numeric level → our 4-bucket level. */
export function bucketLevel(level: unknown): LogLevel {
  const n = typeof level === 'number' ? level : 30
  if (n >= 50) return 'error' // error(50) + fatal(60)
  if (n >= 40) return 'warn' // warn(40)
  if (n >= 30) return 'info' // info(30)
  return 'debug' // debug(20) + trace(10)
}

// Module keys the codebase already logs ad-hoc; lifted into a `"<kind>:<name>"` label best-effort. An
// explicit `module` binding (e.g. from a future log.child({ module })) wins.
const MODULE_KEYS = ['charger', 'vehicle', 'tariff', 'balancer', 'loadpoint', 'meter'] as const
// pino framing + fields we lift into their own columns — never echoed back into `fields`.
const NON_FIELD_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'v', 'err', 'module'])

function extractModule(rec: Record<string, unknown>): string | null {
  if (typeof rec.module === 'string') return rec.module
  for (const k of MODULE_KEYS) {
    const v = rec[k]
    if (typeof v === 'string') return `${k}:${v}`
  }
  return null
}

function extractErr(rec: Record<string, unknown>): string | null {
  const e = rec.err
  if (e == null) return null
  if (typeof e === 'string') return e
  if (typeof e === 'object') {
    const o = e as Record<string, unknown>
    if (typeof o.stack === 'string') return o.stack
    if (typeof o.message === 'string') return o.message
  }
  return String(e)
}

function extractFields(rec: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rec)) if (!NON_FIELD_KEYS.has(k)) out[k] = v
  return Object.keys(out).length > 0 ? out : null
}

/** Map one parsed pino record to a persistable row. Exported for unit testing. */
export function pinoRecordToLog(rec: Record<string, unknown>): LogRecord {
  const t =
    rec.time == null
      ? new Date()
      : typeof rec.time === 'number'
        ? new Date(rec.time)
        : new Date(String(rec.time))
  return {
    time: (Number.isNaN(t.getTime()) ? new Date() : t).toISOString(),
    level: bucketLevel(rec.level),
    module: extractModule(rec),
    msg: typeof rec.msg === 'string' ? rec.msg : '',
    fields: extractFields(rec),
    err: extractErr(rec),
  }
}

/**
 * A pino multistream leg that persists every record. Buffers partial writes and splits on newlines
 * (pino emits NDJSON). Non-JSON lines are stored raw at info. Synchronous inserts (node:sqlite) on the
 * log call's stack — fine at this volume, like insertMeterValues on the meter path.
 */
export function createLogCaptureStream(db: DatabaseSync): Writable {
  let buf = ''
  return new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) captureLine(db, line)
      }
      cb()
    },
  })
}

function captureLine(db: DatabaseSync, line: string): void {
  try {
    insertLog(db, pinoRecordToLog(JSON.parse(line) as Record<string, unknown>))
  } catch {
    // Not JSON (shouldn't happen on the pino stream) — keep it rather than lose it.
    insertLog(db, {
      time: new Date().toISOString(),
      level: 'info',
      module: null,
      msg: line,
      fields: null,
      err: null,
    })
  }
}

// ── console tee (third-party safety net) ─────────────────────────────────────────────────────────
const CONSOLE_METHODS: Array<[string, LogLevel]> = [
  ['log', 'info'],
  ['info', 'info'],
  ['debug', 'debug'],
  ['warn', 'warn'],
  ['error', 'error'],
]

/**
 * Tee console.* into the log store while preserving the original output. Catches plugins/deps that
 * write to console instead of ctx.log. Disjoint from the pino leg (pino writes to the fd, not through
 * console), so no double-capture. Install once, early (before plugins load). Returns a restore fn.
 */
export function patchConsole(db: DatabaseSync): () => void {
  const c = console as unknown as Record<string, (...args: unknown[]) => void>
  const originals = new Map<string, (...args: unknown[]) => void>()
  let reentrant = false // guard against a console call from inside the insert path
  for (const [method, level] of CONSOLE_METHODS) {
    const orig = c[method]
    originals.set(method, orig)
    c[method] = (...args: unknown[]) => {
      orig(...args)
      if (reentrant) return
      reentrant = true
      try {
        insertLog(db, {
          time: new Date().toISOString(),
          level,
          module: null,
          msg: formatArgs(...args),
          fields: null,
          err: null,
        })
      } finally {
        reentrant = false
      }
    }
  }
  return () => {
    for (const [method, orig] of originals) c[method] = orig
  }
}

// ── query + prune ────────────────────────────────────────────────────────────────────────────────
export interface LogQuery {
  level?: LogLevel // MINIMUM severity (rank debug<info<warn<error)
  since?: string // ISO — at/after
  until?: string // ISO — at/before
  q?: string // case-insensitive substring on msg + module
  limit?: number // default 200, hard cap 500
}

interface LogRow {
  id: number
  time: string
  level: string
  module: string | null
  msg: string
  fields: string | null
  err: string | null
}

// Shared WHERE builder for queryLogs + exportLogsText. `level` is a MINIMUM (floor); `q` is a literal
// substring on msg + module (LIKE metachars escaped, matching the mock's .includes()).
function buildLogFilter(query: LogQuery): { where: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  if (query.level) {
    const minRank = LEVEL_ORDER.indexOf(query.level)
    const allowed = minRank >= 0 ? LEVEL_ORDER.slice(minRank) : LEVEL_ORDER
    clauses.push(`level IN (${allowed.map(() => '?').join(', ')})`)
    params.push(...allowed)
  }
  if (query.since) {
    clauses.push('time >= ?')
    params.push(query.since)
  }
  if (query.until) {
    clauses.push('time <= ?')
    params.push(query.until)
  }
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`
    clauses.push(`(msg LIKE ? ESCAPE '\\' OR module LIKE ? ESCAPE '\\')`)
    params.push(like, like)
  }
  return { where: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params }
}

function rowToEntry(r: LogRow): LogEntry {
  const entry: LogEntry = { id: r.id, time: r.time, level: r.level as LogLevel, msg: r.msg }
  if (r.module) entry.module = r.module
  if (r.err) entry.err = r.err
  if (r.fields) {
    try {
      entry.fields = JSON.parse(r.fields) as Record<string, unknown>
    } catch {
      /* leave fields absent on corrupt JSON */
    }
  }
  return entry
}

/** Newest-first, mirrors GET /api/transactions. `level` is a floor, not an exact match. */
export function queryLogs(db: DatabaseSync, query: LogQuery = {}): LogEntry[] {
  const { where, params } = buildLogFilter(query)
  const limit = Math.min(query.limit && query.limit > 0 ? query.limit : 200, 500)
  const sql = `SELECT id, time, level, module, msg, fields, err FROM logs${where} ORDER BY id DESC LIMIT ?`
  const rows = db.prepare(sql).all(...([...params, limit] as never[])) as unknown as LogRow[]
  return rows.map(rowToEntry)
}

/** One human-readable `.log` line: `<ISO> <LEVEL> [<module>] <msg> <fields-json>`; err stack indented below. */
export function formatLogLine(e: LogEntry): string {
  let line = `${e.time} ${e.level.toUpperCase().padEnd(5)}`
  if (e.module) line += ` [${e.module}]`
  line += ` ${e.msg}`
  if (e.fields) line += ` ${JSON.stringify(e.fields)}`
  if (e.err)
    line +=
      '\n' +
      e.err
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n')
  return line
}

/**
 * The full filtered log set as a `.log` text blob for download — same filter as queryLogs but WITHOUT
 * the viewer's 200/500 limit (bounded only by `cap` as an OOM backstop) and CHRONOLOGICAL (oldest-first,
 * like a real logfile). Backs GET /api/logs/export.
 */
export function exportLogsText(db: DatabaseSync, query: LogQuery = {}, cap = 200_000): string {
  const { where, params } = buildLogFilter(query)
  const sql = `SELECT id, time, level, module, msg, fields, err FROM logs${where} ORDER BY id ASC LIMIT ?`
  const rows = db.prepare(sql).all(...([...params, cap] as never[])) as unknown as LogRow[]
  return rows.map((r) => formatLogLine(rowToEntry(r))).join('\n') + (rows.length > 0 ? '\n' : '')
}

/**
 * Auto-rotate: drop rows older than `retentionDays`, then enforce a hard `maxRows` backstop (guards a
 * runaway log storm between prunes). Age is the user-facing knob; the cap is defense-in-depth. Cheap
 * housekeeping — call on startup + an interval, never on the hot insert path. Never throws.
 */
export function pruneLogs(db: DatabaseSync, retentionDays: number, maxRows = 200_000): void {
  try {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600_000).toISOString()
    db.prepare('DELETE FROM logs WHERE time < ?').run(cutoff)
    // MAX(id) is NULL on an empty table → the predicate matches nothing. Keeps the newest maxRows.
    db.prepare('DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?').run(maxRows)
  } catch {
    /* housekeeping — never crash the app */
  }
}
