export interface SkodaCfg {
  name: string
  username: string
  password: string
  vin: string
}

// Polling cadence is NOT configured here — the lifecycle owns when to refresh a vehicle
// (on connect + during charging), via site.smartCharging.vehiclePollIntervalSec.
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
    // Broad string enum (CHARGING | READY_FOR_CHARGING | CONNECT_CABLE | CONSERVING | …) —
    // kept as string so an unexpected value never breaks parsing.
    state?: string
    chargePowerInKw?: number
    remainingTimeToFullyChargedInMinutes?: number
  }
  settings?: {
    targetStateOfChargeInPercent?: number
  }
}

// Subset of /v2/air-conditioning/{vin} response we care about (plug + climate state).
export interface SkodaAirConditioningResponse {
  state?: string // OFF | HEATING | HEATING_AUXILIARY | COOLING | VENTILATION | ON | …
  chargerConnectionState?: string // CONNECTED | DISCONNECTED | …
  chargerLockState?: string
}
