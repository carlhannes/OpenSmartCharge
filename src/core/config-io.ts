import { stringify, parse } from 'yaml'
import type { DatabaseSync } from 'node:sqlite'
import { configSchema, type ChargeMode, type Config } from './config.js'
import {
  setOverride,
  applyConfigOverrides,
  validateConfigWith,
  type OverrideKind,
  type OverrideRow,
} from './config-overrides.js'
import { applyConfigToLoadpoints } from './loadpoint.js'
import { setTimezone, setLogRetentionDays } from './settings.js'

// Import/export serialization of the CONFIG (not runtime history/cache). The exported document is a
// superset of osc.yaml: the config sections plus the runtime-owned settings that are still config
// (loadpoint mode/targets from loadpoint_state, timezone + log retention from settings). It omits
// schema defaults so the file stays small, and redacts credentials unless explicitly asked. This is
// the read side; the write side (import) lives alongside and reuses the same document shape.

/** Placeholder shown in place of a secret in redacted exports/responses. On import a field equal to
 *  this is treated as "unchanged" so a redacted round-trip never clobbers the real credential. */
export const REDACTED = '••••••'

/** Default log-retention days (mirrors settings.ts) — omitted from the export when unchanged. */
const DEFAULT_LOG_RETENTION_DAYS = 3

// The all-defaults config — the baseline a field must differ from to be worth exporting. Every
// top-level config field has a default or is optional, so parsing `{}` yields a complete config.
const DEFAULTS = configSchema.parse({})

/** Runtime state the export needs beyond the structural Config — the live per-loadpoint mode/targets. */
export type LoadpointRuntime = {
  mode: ChargeMode
  targetSoc?: number
  targetTime?: string
  targetKWh?: number
  minSoc?: number
}

export interface ConfigExportInput {
  /** The live effective config (defaults ⊕ overrides). */
  effective: Config
  /** Per-loadpoint runtime mode/targets (from loadpoint_state). */
  loadpointState: Map<string, LoadpointRuntime>
  /** Effective site timezone (settings KV, which can diverge from the osc.yaml seed). */
  timezone: string
  /** Log-retention days (settings KV). */
  logRetentionDays: number
  /** Include plaintext credentials (full-fidelity backup) vs redact them (default). */
  secrets: boolean
}

/** Fields of `obj` that differ (deep) from `def`. */
function diffFields(
  obj: Record<string, unknown>,
  def: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && JSON.stringify(obj[k]) !== JSON.stringify(def[k])) out[k] = obj[k]
  }
  return out
}

/** Drop undefined-valued keys so the serialized document stays clean. */
function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** Recursively replace any `password` field with the redaction placeholder. */
function redactPasswords<T>(v: T): T {
  if (Array.isArray(v)) return v.map(redactPasswords) as T
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      out[k] = k === 'password' ? REDACTED : redactPasswords(val)
    }
    return out as T
  }
  return v
}

/**
 * Assemble the export document (a plain object; serialize with {@link serializeConfig}). Singletons
 * (site, smartCharging) carry only their non-default fields; entities are exported whole; loadpoints
 * carry their bindings + the live mode/targets (defaultMode = the runtime mode). Credentials are
 * redacted unless `secrets`.
 */
export function buildConfigExport(inp: ConfigExportInput): Record<string, unknown> {
  const { effective: c, loadpointState, timezone, logRetentionDays, secrets } = inp
  const doc: Record<string, unknown> = {}

  // site: non-default scalars, with the LIVE timezone (settings) not the seed.
  const site = diffFields({ ...c.site, timezone }, DEFAULTS.site as Record<string, unknown>)
  if (Object.keys(site).length) doc.site = site

  const sc = diffFields(
    c.smartCharging as unknown as Record<string, unknown>,
    DEFAULTS.smartCharging as unknown as Record<string, unknown>,
  )
  if (Object.keys(sc).length) doc.smartCharging = sc

  if (c.mqttBridge) doc.mqttBridge = c.mqttBridge

  // Entities: exported whole (a configured entity is inherently non-default). Their module-specific
  // fields (zone, stationId, maxA, broker, …) flow through the schema's catchall.
  if (c.tariffs.length) doc.tariffs = c.tariffs
  if (c.balancers.length) doc.balancers = c.balancers
  if (c.vehicles.length) doc.vehicles = c.vehicles
  if (c.chargers.length) doc.chargers = c.chargers
  if (c.meterReaders.length) doc.meterReaders = c.meterReaders

  // loadpoints: bindings from the config + the live mode/targets (loadpoint_state). defaultMode
  // carries the current mode so a re-import seeds it.
  doc.loadpoints = c.loadpoints.map((lp) => {
    const st = loadpointState.get(lp.name)
    return clean({
      name: lp.name,
      charger: lp.charger,
      tariff: lp.tariff,
      balancer: lp.balancer,
      vehicle: lp.vehicle,
      defaultMode: st?.mode ?? lp.defaultMode,
      targetSoc: st?.targetSoc,
      targetTime: st?.targetTime,
      targetKWh: st?.targetKWh,
      minSoc: st?.minSoc,
    })
  })

  if (logRetentionDays !== DEFAULT_LOG_RETENTION_DAYS)
    doc.logs = { retentionDays: logRetentionDays }

  return secrets ? doc : redactPasswords(doc)
}

/** Serialize an export document to YAML (the osc.yaml format). */
export function serializeConfig(doc: Record<string, unknown>): string {
  return stringify(doc, { lineWidth: 0 })
}

// ── Import ───────────────────────────────────────────────────────────────────────────────────────
// Import writes the DB config store (config_overrides + settings + loadpoint_state) and takes effect
// on the next boot — same semantics as `config:apply` (a bulk config swap warrants a restart; the
// granular PUT endpoints are the live-edit path). It validates the WOULD-BE effective config before
// writing anything, so a bad import is rejected whole rather than half-applied.

/** Coerce an import body (a YAML/JSON string, or an already-parsed object) into a document object. */
export function coerceConfigDocument(input: unknown): Record<string, unknown> {
  const parsed = typeof input === 'string' ? parse(input) : input
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config must be a YAML/JSON object')
  }
  return parsed as Record<string, unknown>
}

const SINGLETON_SECTIONS: ReadonlyArray<['site' | 'smartCharging' | 'mqttBridge', OverrideKind]> = [
  ['site', 'site'],
  ['smartCharging', 'smartCharging'],
  ['mqttBridge', 'mqttBridge'],
]
const ENTITY_SECTIONS: ReadonlyArray<[string, OverrideKind]> = [
  ['tariffs', 'tariff'],
  ['balancers', 'balancer'],
  ['vehicles', 'vehicle'],
  ['chargers', 'charger'],
  ['meterReaders', 'meterReader'],
  ['loadpoints', 'loadpoint'],
]

/** The config document → the override rows it implies (singletons keyed by kind; entities by name). */
function docToOverrideRows(doc: Record<string, unknown>): OverrideRow[] {
  const rows: OverrideRow[] = []
  for (const [section, kind] of SINGLETON_SECTIONS) {
    const v = doc[section]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      rows.push({ kind, name: kind, patch: v as Record<string, unknown> })
    }
  }
  for (const [section, kind] of ENTITY_SECTIONS) {
    const arr = doc[section]
    if (!Array.isArray(arr)) continue
    for (const e of arr as Array<Record<string, unknown>>) {
      const name = typeof e.name === 'string' ? e.name : ''
      if (!name) continue
      const patch = { ...e }
      delete patch.name
      rows.push({ kind, name, patch })
    }
  }
  return rows
}

/**
 * Replace redaction placeholders in `doc` with the real secret from `cur` (the current effective
 * config), matched by location. A redacted round-trip therefore keeps existing credentials; a
 * placeholder with no prior value is dropped (never persisted). Mutates + returns `doc`.
 */
function deRedact(doc: Record<string, unknown>, cur: Config): Record<string, unknown> {
  const keep = (redacted: boolean, real: string | undefined, set: (v?: string) => void): void => {
    if (!redacted) return
    if (real !== undefined) set(real)
    else set(undefined)
  }
  const mb = doc.mqttBridge as { broker?: { password?: string } } | undefined
  if (mb?.broker) {
    keep(mb.broker.password === REDACTED, cur.mqttBridge?.broker?.password, (v) => {
      if (v === undefined) delete mb.broker!.password
      else mb.broker!.password = v
    })
  }
  const vs = doc.vehicles as Array<{ name: string; password?: string }> | undefined
  if (Array.isArray(vs)) {
    for (const v of vs) {
      const real = (
        cur.vehicles.find((x) => x.name === v.name) as { password?: string } | undefined
      )?.password
      keep(v.password === REDACTED, real, (nv) => {
        if (nv === undefined) delete v.password
        else v.password = nv
      })
    }
  }
  const ms = doc.meterReaders as Array<{ name: string; broker?: { password?: string } }> | undefined
  if (Array.isArray(ms)) {
    for (const m of ms) {
      if (!m.broker) continue
      const real = (
        cur.meterReaders.find((x) => x.name === m.name) as
          | { broker?: { password?: string } }
          | undefined
      )?.broker?.password
      keep(m.broker.password === REDACTED, real, (nv) => {
        if (nv === undefined) delete m.broker!.password
        else m.broker!.password = nv
      })
    }
  }
  return doc
}

export interface ImportOptions {
  /** `merge` overlays the document onto the current config; `replace` blanks everything first. */
  mode: 'merge' | 'replace'
  /** The live effective config — the merge base + the source of existing creds for de-redaction. */
  currentEffective: Config
  /** Validate only; write nothing. */
  dryRun?: boolean
}

export interface ImportResult {
  dryRun: boolean
  mode: 'merge' | 'replace'
  /** Top-level sections present in the imported document. */
  sections: string[]
  /** Bulk imports apply on the next boot (like config:apply), so this is always true. */
  restartRequired: boolean
}

/**
 * Apply an import document to the DB config store. Throws (with a ZodError message) if the resulting
 * config is invalid — BEFORE writing anything. `replace` clears all overrides + loadpoint_state and
 * resets timezone/retention to the document's values (defaulting when absent) — a true blank slate;
 * `merge` writes only the sections present, leaving the rest untouched. Redacted credentials are
 * resolved against the current config so a redacted round-trip never wipes a secret.
 */
export function importConfig(
  db: DatabaseSync,
  docIn: Record<string, unknown>,
  opts: ImportOptions,
): ImportResult {
  const doc = deRedact(structuredClone(docIn), opts.currentEffective)
  const rows = docToOverrideRows(doc)

  // Validate the would-be effective config first. replace validates against defaults (the document
  // is the whole config); merge validates against the current config (the document is an overlay).
  validateConfigWith(opts.mode === 'replace' ? DEFAULTS : opts.currentEffective, rows)

  const sections = Object.keys(doc)
  if (opts.dryRun) return { dryRun: true, mode: opts.mode, sections, restartRequired: true }

  if (opts.mode === 'replace') {
    applyConfigOverrides(opts.currentEffective, db, { prune: true }) // clear ALL config overrides
    db.prepare('DELETE FROM loadpoint_state').run() // blank runtime mode/targets — re-seeded below
  }
  for (const r of rows) setOverride(db, r.kind, r.name, r.patch)

  // settings KV: on replace, reset to the document's value (or the default when absent); on merge,
  // only touch what the document specifies.
  const site = doc.site as { timezone?: string } | undefined
  const retention = (doc.logs as { retentionDays?: number } | undefined)?.retentionDays
  if (opts.mode === 'replace') {
    setTimezone(db, site?.timezone ?? DEFAULTS.site.timezone)
    setLogRetentionDays(db, retention ?? DEFAULT_LOG_RETENTION_DAYS)
  } else {
    if (site?.timezone) setTimezone(db, site.timezone)
    if (retention !== undefined) setLogRetentionDays(db, retention)
  }

  // loadpoint runtime mode/targets (loadpoint_state) — declaratively upsert the imported loadpoints
  // (targeted, so a partial merge never disturbs loadpoints absent from the document).
  const lps = doc.loadpoints
  if (Array.isArray(lps) && lps.length) {
    applyConfigToLoadpoints(
      db,
      (lps as Array<Record<string, unknown>>).map((lp) => ({
        name: String(lp.name),
        maxCurrentA: 16, // unused by the loadpoint_state upsert (kept for the shared init shape)
        defaultMode: lp.defaultMode as ChargeMode | undefined,
        targetSoc: lp.targetSoc as number | undefined,
        targetTime: lp.targetTime as string | undefined,
        targetKWh: lp.targetKWh as number | undefined,
        minSoc: lp.minSoc as number | undefined,
      })),
    )
  }

  return { dryRun: false, mode: opts.mode, sections, restartRequired: true }
}
