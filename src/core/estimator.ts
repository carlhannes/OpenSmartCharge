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

// Charging efficiency OBSERVED within one session: (battery kWh gained between two real SoC
// readings) / (grid kWh delivered between them). Lets a mid-session car-API dropout extrapolate SoC
// on THIS car's measured efficiency + charger kWh instead of a generic constant. Returns undefined
// when the deltas are too small to trust or the result falls outside a sane band — the caller then
// keeps the configured default. Session-scoped only; nothing is persisted.
const MIN_OBSERVE_KWH = 3 // need a few kWh delivered before the ratio is meaningful
const MIN_OBSERVE_SOC = 2 // …and >1% SoC gained, so 1% quantization doesn't dominate
const OBSERVE_EFF_MIN = 0.7
const OBSERVE_EFF_MAX = 0.98

export function observedEfficiency(
  first: { soc: number; sessionKWh: number },
  latest: { soc: number; sessionKWh: number },
  batteryCapacityKWh: number | undefined,
): number | undefined {
  if (batteryCapacityKWh === undefined || batteryCapacityKWh <= 0) return undefined
  const deltaSocPct = latest.soc - first.soc
  const deltaKWh = latest.sessionKWh - first.sessionKWh
  if (deltaKWh < MIN_OBSERVE_KWH || deltaSocPct < MIN_OBSERVE_SOC) return undefined
  const eff = ((deltaSocPct / 100) * batteryCapacityKWh) / deltaKWh
  if (eff < OBSERVE_EFF_MIN || eff > OBSERVE_EFF_MAX) return undefined
  return eff
}
