export interface SkodaCfg {
  name: string
  username: string
  password: string
  vin: string
  pollIntervalSec: number
  staleAfterSec: number
}

export function parseConfig(raw: unknown): SkodaCfg {
  if (!raw || typeof raw !== 'object') throw new Error('vehicle-skoda: invalid config')
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string') throw new Error('vehicle-skoda: missing name')
  if (typeof r.username !== 'string') throw new Error('vehicle-skoda: missing username')
  if (typeof r.password !== 'string') throw new Error('vehicle-skoda: missing password')
  if (typeof r.vin !== 'string' || r.vin.length !== 17)
    throw new Error('vehicle-skoda: vin must be 17 chars')
  return {
    name: r.name,
    username: r.username,
    password: r.password,
    vin: r.vin.toUpperCase(),
    pollIntervalSec: typeof r.pollIntervalSec === 'number' ? Math.max(300, r.pollIntervalSec) : 900,
    staleAfterSec: typeof r.staleAfterSec === 'number' ? r.staleAfterSec : 7200,
  }
}

// Subset of /v2/garage/vehicles/{vin} response we care about.
// Skoda API returns camelCase JSON; Go unmarshals case-insensitively.
export interface SkodaVehicleResponse {
  vin?: string
  specification?: {
    battery?: {
      capacityInKWh?: number
    }
  }
}

// Subset of /v1/charging/{vin} response we care about.
export interface SkodaChargingResponse {
  status?: {
    battery?: {
      stateOfChargeInPercent?: number
      remainingCruisingRangeInMeters?: number
    }
    state?: 'CHARGING' | 'READY_FOR_CHARGING' | 'NOT_READY_FOR_CHARGING' | 'CONSERVATION'
  }
}
