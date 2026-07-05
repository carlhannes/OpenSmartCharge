import type { DatabaseSync } from 'node:sqlite'
import { configSchema, type Config } from './config.js'

// Runtime overrides of STRUCTURAL config, layered over the parsed osc.yaml to form the EFFECTIVE
// config the lifecycle runs on. Same seed → DB-wins → config:apply model as settings.ts, but for
// module topology (entity field edits + runtime-added entities) rather than site scalars. The
// reconcile seam (core/reconcile.ts) rebuilds the affected module whenever an override changes.

export type OverrideKind =
  | 'site'
  | 'tariff'
  | 'balancer'
  | 'vehicle'
  | 'charger'
  | 'meterReader'
  | 'loadpoint'

// Each entity kind → the config array it lives in. 'site' is the singleton, merged separately.
const KIND_ARRAY: Record<Exclude<OverrideKind, 'site'>, keyof Config> = {
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

export function setOverride(
  db: DatabaseSync,
  kind: OverrideKind,
  name: string,
  patch: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO config_overrides (kind, name, patch, updated_at)
       VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(kind, name) DO UPDATE SET patch = excluded.patch, updated_at = excluded.updated_at`,
  ).run(kind, name, JSON.stringify(patch))
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
 * The EFFECTIVE config the lifecycle runs on: the parsed osc.yaml (`base`) with every override
 * layered on — a partial patch merged onto the matching entity, or a full entity appended when
 * there's no match (a runtime-added charger/vehicle). `site` merges onto the site object. The
 * merged result is re-validated through the SAME configSchema, so an override can never produce an
 * invalid config: a bad one throws here (loudly) rather than half-applying.
 */
export function getEffectiveConfig(base: Config, db: DatabaseSync): Config {
  const draft = structuredClone(base) as Record<string, unknown>
  for (const { kind, name, patch } of listOverrides(db)) {
    if (kind === 'site') {
      draft.site = { ...(draft.site as Record<string, unknown>), ...patch }
      continue
    }
    const key = KIND_ARRAY[kind]
    const arr = ((draft[key] as Array<{ name?: string }>) ?? []).slice()
    const existing = arr.find((e) => e.name === name)
    if (existing) Object.assign(existing, patch)
    else arr.push({ name, ...patch })
    draft[key] = arr
  }
  return configSchema.parse(draft)
}
