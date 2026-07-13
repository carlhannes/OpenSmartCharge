import type { DatabaseSync } from 'node:sqlite'
import { configSchema, type Config } from './config.js'

// Runtime overrides of STRUCTURAL config, layered over the parsed osc.yaml to form the EFFECTIVE
// config the lifecycle runs on. Same seed → DB-wins → config:apply model as settings.ts, but for
// module topology (entity field edits + runtime-added entities) rather than site scalars. The
// reconcile seam (core/reconcile.ts) rebuilds the affected module whenever an override changes.

export type OverrideKind =
  | 'site'
  | 'smartCharging'
  | 'mqttBridge'
  | 'tariff'
  | 'balancer'
  | 'vehicle'
  | 'charger'
  | 'meterReader'
  | 'loadpoint'

// Singleton (object) kinds are merged onto the config object of the SAME name; entity kinds are
// named elements of a config array. A singleton override's `name` is the kind itself (e.g. 'site').
type SingletonKind = 'site' | 'smartCharging' | 'mqttBridge'
const SINGLETON_KINDS: readonly SingletonKind[] = ['site', 'smartCharging', 'mqttBridge']
const isSingletonKind = (k: OverrideKind): k is SingletonKind =>
  (SINGLETON_KINDS as readonly string[]).includes(k)

// Each ENTITY kind → the config array it lives in.
const KIND_ARRAY: Record<Exclude<OverrideKind, SingletonKind>, keyof Config> = {
  tariff: 'tariffs',
  balancer: 'balancers',
  vehicle: 'vehicles',
  charger: 'chargers',
  meterReader: 'meterReaders',
  loadpoint: 'loadpoints',
}

export interface OverrideRow {
  kind: OverrideKind
  name: string
  patch: Record<string, unknown>
}

export function getOverride(
  db: DatabaseSync,
  kind: OverrideKind,
  name: string,
): Record<string, unknown> | undefined {
  const row = db
    .prepare('SELECT patch FROM config_overrides WHERE kind = ? AND name = ?')
    .get(kind, name) as { patch: string } | undefined
  return row ? (JSON.parse(row.patch) as Record<string, unknown>) : undefined
}

// MERGES the patch into any existing override for (kind, name), so partial updates compose (e.g. a
// PUT that changes only maxA keeps a claimed charger's type/stationId). Reset a field to the config
// value via deleteOverride (whole entity) or `npm run config:apply`.
export function setOverride(
  db: DatabaseSync,
  kind: OverrideKind,
  name: string,
  patch: Record<string, unknown>,
): void {
  const merged = { ...(getOverride(db, kind, name) ?? {}), ...patch }
  db.prepare(
    `INSERT INTO config_overrides (kind, name, patch, updated_at)
       VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(kind, name) DO UPDATE SET patch = excluded.patch, updated_at = excluded.updated_at`,
  ).run(kind, name, JSON.stringify(merged))
}

export function deleteOverride(db: DatabaseSync, kind: OverrideKind, name: string): boolean {
  return (
    db.prepare('DELETE FROM config_overrides WHERE kind = ? AND name = ?').run(kind, name).changes >
    0
  )
}

export function listOverrides(db: DatabaseSync): OverrideRow[] {
  const rows = db
    .prepare('SELECT kind, name, patch FROM config_overrides ORDER BY kind, name')
    .all() as unknown as { kind: string; name: string; patch: string }[]
  return rows.map((r) => ({
    kind: r.kind as OverrideKind,
    name: r.name,
    patch: JSON.parse(r.patch) as Record<string, unknown>,
  }))
}

/**
 * `config:apply` reconciliation for structural overrides. Entities PRESENT in osc.yaml have their
 * overrides CLEARED (the file re-asserts itself); runtime-added entities with no osc.yaml counterpart
 * (a claimed charger / added vehicle) are PRESERVED — deleting one the user is actively using would
 * be a footgun. `prune: true` clears everything (DB == file). Returns what it did, for the CLI diff.
 */
export function applyConfigOverrides(
  base: Config,
  db: DatabaseSync,
  opts: { prune?: boolean } = {},
): { cleared: OverrideRow[]; preserved: OverrideRow[] } {
  const inBase = (kind: OverrideKind, name: string): boolean => {
    if (isSingletonKind(kind)) return true
    const arr = (base[KIND_ARRAY[kind]] as Array<{ name: string }>) ?? []
    return arr.some((e) => e.name === name)
  }
  const cleared: OverrideRow[] = []
  const preserved: OverrideRow[] = []
  for (const row of listOverrides(db)) {
    if (opts.prune || inBase(row.kind, row.name)) {
      deleteOverride(db, row.kind, row.name)
      cleared.push(row)
    } else {
      preserved.push(row)
    }
  }
  return { cleared, preserved }
}

// Apply one override onto a draft config object — the merge rule shared by getEffectiveConfig and
// validateConfigWith. A singleton (site/smartCharging/mqttBridge) merges onto its same-named object;
// an entity patch merges onto the matching array element, or a full entity is appended when there's
// no match (a runtime-added charger/vehicle). Mutates `draft`. (mqttBridge is optional/undefined by
// default: merging onto {} then re-validating requires the patch/base to supply the required
// broker.host — the writer/import guarantees a complete singleton.)
function mergeOverrideInto(
  draft: Record<string, unknown>,
  kind: OverrideKind,
  name: string,
  patch: Record<string, unknown>,
): void {
  if (isSingletonKind(kind)) {
    draft[kind] = { ...((draft[kind] as Record<string, unknown>) ?? {}), ...patch }
    return
  }
  const key = KIND_ARRAY[kind]
  const arr = ((draft[key] as Array<{ name?: string }>) ?? []).slice()
  const existing = arr.find((e) => e.name === name)
  if (existing) Object.assign(existing, patch)
  else arr.push({ name, ...patch })
  draft[key] = arr
}

/**
 * The EFFECTIVE config the lifecycle runs on: the `base` config with every override layered on. The
 * merged result is re-validated through the SAME configSchema, so an override can never produce an
 * invalid config: a bad one throws here (loudly) rather than half-applying.
 */
export function getEffectiveConfig(base: Config, db: DatabaseSync): Config {
  const draft = structuredClone(base) as Record<string, unknown>
  for (const { kind, name, patch } of listOverrides(db)) mergeOverrideInto(draft, kind, name, patch)
  return configSchema.parse(draft)
}

/**
 * Validate the config that WOULD result from applying `edits` on top of `from` (typically the
 * current effective config), WITHOUT persisting. Throws a ZodError on an invalid result — call this
 * BEFORE setOverride so a bad write is rejected (400) rather than persisted and only throwing on the
 * next getEffectiveConfig (which would also brick boot). Returns the validated candidate config.
 */
export function validateConfigWith(from: Config, edits: OverrideRow[]): Config {
  const draft = structuredClone(from) as Record<string, unknown>
  for (const { kind, name, patch } of edits) mergeOverrideInto(draft, kind, name, patch)
  return configSchema.parse(draft)
}
