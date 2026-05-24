import type { SkodaVehicleResponse, SkodaChargingResponse } from './types.js'

const BASE_URI = 'https://mysmob.api.connect.skoda-auto.cz/api'
// Connectivity generations required by the Skoda API (from evcc params.go)
const ALL_GEN =
  'connectivityGenerations=MOD1&connectivityGenerations=MOD2&connectivityGenerations=MOD3&connectivityGenerations=MOD4'

export async function getVehicleDetails(
  vin: string,
  accessToken: string,
  fetchFn: typeof globalThis.fetch,
): Promise<SkodaVehicleResponse> {
  const url = `${BASE_URI}/v2/garage/vehicles/${vin}?${ALL_GEN}`
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Skoda /v2/garage/vehicles: HTTP ${res.status}`)
  return res.json() as Promise<SkodaVehicleResponse>
}

export async function getChargingStatus(
  vin: string,
  accessToken: string,
  fetchFn: typeof globalThis.fetch,
): Promise<SkodaChargingResponse> {
  const url = `${BASE_URI}/v1/charging/${vin}`
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Skoda /v1/charging: HTTP ${res.status}`)
  return res.json() as Promise<SkodaChargingResponse>
}
