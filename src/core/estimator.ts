import { DEFAULT_CHARGING_EFFICIENCY } from './electrical.js'

// Estimates current SoC when the vehicle API is unavailable.
// Requires at least one prior successful vehicle read to have cached batteryCapacityKWh.
// Returns undefined if capacity is unknown.
export function estimateSoc(
  lastKnownSoc: number,
  sessionKWhDelivered: number,
  batteryCapacityKWh: number | undefined,
  chargingEfficiency = DEFAULT_CHARGING_EFFICIENCY,
): number | undefined {
  if (batteryCapacityKWh === undefined || batteryCapacityKWh <= 0) return undefined
  const addedSocPct = (sessionKWhDelivered * chargingEfficiency * 100) / batteryCapacityKWh
  return Math.min(100, lastKnownSoc + addedSocPct)
}
