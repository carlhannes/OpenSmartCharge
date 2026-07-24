import type { DatabaseSync } from 'node:sqlite'
import type { VehicleData } from '../../sdk/vehicle.js'

// Persist booleans as a tri-state (NULL = unknown, 1 = true, 0 = false) so a field the car API
// didn't return (e.g. pluggedIn when the air-con call failed) survives as "unknown" rather than
// being read back as a definite false.
const boolCol = (b: boolean | undefined): number | null => (b == null ? null : b ? 1 : 0)

export function upsertVehicleCache(
  db: DatabaseSync,
  name: string,
  data: {
    soc: number
    batteryCapacityKWh?: number
    range?: number
    isCharging?: boolean
    targetSoc?: number
    pluggedIn?: boolean
    climateActive?: boolean
  },
): void {
  db.prepare(
    `INSERT INTO vehicle_cache
       (vehicle_name, soc, battery_capacity_kwh, range_km, is_charging, target_soc, plugged_in, climate_active, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (vehicle_name) DO UPDATE SET
         soc                  = excluded.soc,
         battery_capacity_kwh = excluded.battery_capacity_kwh,
         range_km             = excluded.range_km,
         is_charging          = excluded.is_charging,
         target_soc           = excluded.target_soc,
         plugged_in           = excluded.plugged_in,
         climate_active       = excluded.climate_active,
         fetched_at           = excluded.fetched_at`,
  ).run(
    name,
    data.soc,
    data.batteryCapacityKWh ?? null,
    data.range ?? null,
    boolCol(data.isCharging),
    data.targetSoc ?? null,
    boolCol(data.pluggedIn),
    boolCol(data.climateActive),
  )
}

export function loadVehicleCache(db: DatabaseSync, name: string): VehicleData | null {
  const row = db.prepare('SELECT * FROM vehicle_cache WHERE vehicle_name = ?').get(name) as
    | {
        soc: number
        battery_capacity_kwh: number | null
        range_km: number | null
        is_charging: number | null
        target_soc: number | null
        plugged_in: number | null
        climate_active: number | null
        fetched_at: string
      }
    | undefined
  if (!row) return null
  const bool = (v: number | null): boolean | undefined => (v == null ? undefined : v === 1)
  return {
    soc: row.soc,
    batteryCapacity: row.battery_capacity_kwh ?? undefined,
    range: row.range_km ?? undefined,
    isCharging: bool(row.is_charging),
    targetSoc: row.target_soc ?? undefined,
    pluggedIn: bool(row.plugged_in),
    climateActive: bool(row.climate_active),
    // SQLite datetime() returns UTC without 'Z' suffix — add it for correct parsing
    fetchedAt: new Date(row.fetched_at + 'Z'),
  }
}

export function saveRefreshToken(db: DatabaseSync, name: string, token: string): void {
  db.prepare(
    `INSERT INTO module_kv (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(`skoda:${name}:refresh_token`, token)
}

export function loadRefreshToken(db: DatabaseSync, name: string): string | null {
  const row = db
    .prepare('SELECT value FROM module_kv WHERE key = ?')
    .get(`skoda:${name}:refresh_token`) as { value: string } | undefined
  return row?.value ?? null
}
