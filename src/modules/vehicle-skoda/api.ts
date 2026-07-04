import type {
  SkodaVehicleResponse,
  SkodaChargingResponse,
  SkodaAirConditioningResponse,
} from './types.js'

const BASE_URI = 'https://mysmob.api.connect.skoda-auto.cz/api'
// Connectivity generations required by the Skoda API (from evcc params.go)
const ALL_GEN =
  'connectivityGenerations=MOD1&connectivityGenerations=MOD2&connectivityGenerations=MOD3&connectivityGenerations=MOD4'

// Shared authenticated GET. Surfaces rate-limiting (429/430) as a distinct, legible error so a
// hard limit is obvious in logs. (Our cadence — poll on connect + ~30 min while charging, never
// idle — keeps us far under the limits, but a 429 should still be unmistakable.)
async function skodaGet<T>(
  path: string,
  accessToken: string,
  fetchFn: typeof globalThis.fetch,
): Promise<T> {
  const res = await fetchFn(`${BASE_URI}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 429 || res.status === 430) {
    const retryAfter = res.headers.get('retry-after')
    throw new Error(
      `Skoda ${path}: rate limited (HTTP ${res.status}${retryAfter ? `; retry-after ${retryAfter}s` : ''})`,
    )
  }
  if (!res.ok) throw new Error(`Skoda ${path}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

// GET /v2/garage/vehicles/{vin} — battery capacity (stable per VIN; fetched once).
export function getVehicleDetails(
  vin: string,
  accessToken: string,
  fetchFn: typeof globalThis.fetch,
): Promise<SkodaVehicleResponse> {
  return skodaGet(`/v2/garage/vehicles/${vin}?${ALL_GEN}`, accessToken, fetchFn)
}

// GET /v1/charging/{vin} — SoC, range, state, power, target, time-to-full.
export function getChargingStatus(
  vin: string,
  accessToken: string,
  fetchFn: typeof globalThis.fetch,
): Promise<SkodaChargingResponse> {
  return skodaGet(`/v1/charging/${vin}`, accessToken, fetchFn)
}

// GET /v2/air-conditioning/{vin} — climate + plug-connection state. The car's own view of
// whether a cable is connected — a cross-check independent of the OCPP charger's status.
export function getAirConditioning(
  vin: string,
  accessToken: string,
  fetchFn: typeof globalThis.fetch,
): Promise<SkodaAirConditioningResponse> {
  return skodaGet(`/v2/air-conditioning/${vin}`, accessToken, fetchFn)
}
