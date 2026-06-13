import type { DatabaseSync } from 'node:sqlite'
import type { VehicleData } from '../../sdk/vehicle.js'

export function upsertVehicleCache(
  db: DatabaseSync,
  name: string,
  data: { soc: number; batteryCapacityKWh?: number; range?: number; isCharging?: boolean },
): void {
  db.prepare(
    `INSERT INTO vehicle_cache (vehicle_name, soc, battery_capacity_kwh, range_km, is_charging, fetched_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (vehicle_name) DO UPDATE SET
         soc                  = excluded.soc,
         battery_capacity_kwh = excluded.battery_capacity_kwh,
         range_km             = excluded.range_km,
         is_charging          = excluded.is_charging,
         fetched_at           = excluded.fetched_at`,
  ).run(
    name,
    data.soc,
    data.batteryCapacityKWh ?? null,
    data.range ?? null,
    data.isCharging ? 1 : 0,
  )
}

export function loadVehicleCache(db: DatabaseSync, name: string): VehicleData | null {
  const row = db.prepare('SELECT * FROM vehicle_cache WHERE vehicle_name = ?').get(name) as
    | {
        soc: number
        battery_capacity_kwh: number | null
        range_km: number | null
        is_charging: number
        fetched_at: string
      }
    | undefined
  if (!row) return null
  return {
    soc: row.soc,
    batteryCapacity: row.battery_capacity_kwh ?? undefined,
    range: row.range_km ?? undefined,
    isCharging: row.is_charging === 1,
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
