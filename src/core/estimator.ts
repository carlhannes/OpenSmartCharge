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

// Re-anchored SoC estimate: a real reading captured mid-session (anchorSoc, at anchorSessionKWh)
// carried forward by ONLY the energy delivered SINCE that reading — never the whole session on top
// of a mid-session reading (which would double-count). A periodic real refresh re-anchors it to
// reality. Returns undefined when capacity is unknown (same contract as estimateSoc).
export function estimateSocSinceAnchor(
  anchorSoc: number,
  anchorSessionKWh: number,
  sessionKWhNow: number,
  batteryCapacityKWh: number | undefined,
  chargingEfficiency = DEFAULT_CHARGING_EFFICIENCY,
): number | undefined {
  const deltaKWh = Math.max(0, sessionKWhNow - anchorSessionKWh)
  return estimateSoc(anchorSoc, deltaKWh, batteryCapacityKWh, chargingEfficiency)
}
