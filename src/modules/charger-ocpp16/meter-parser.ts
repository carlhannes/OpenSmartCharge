import type { MeterValue, MeterValuesReq } from './types.js'

export interface ParsedMeterValue {
  energyKwh?: number
  powerW?: number
  currentA?: number
  voltageV?: number
  socPct?: number
}

// Extracted from persistence.ts insertMeterValues so the (fragile) measurand lookup,
// NaN/missing handling, and Wh→kWh conversion can be unit-tested in isolation.

/**
 * Pulls the measurands we care about out of one OCPP MeterValue.
 * A measurand that is absent or non-numeric is omitted (undefined), never NaN.
 * Energy is converted from Wh (OCPP `Energy.Active.Import.Register`) to kWh.
 */
export function parseMeterValue(mv: MeterValue): ParsedMeterValue {
  const get = (measurand: string) => mv.sampledValue.find((s) => s.measurand === measurand)?.value
  const num = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined
    const n = parseFloat(raw)
    return isNaN(n) ? undefined : n
  }

  // The energy register is Wh by default (OCPP), but some chargers report kWh and say so via
  // `unit`. Respect the declared unit instead of always dividing by 1000 (a kWh reading divided
  // by 1000 would be 1000× too small and corrupt the session-energy delta).
  const energySample = mv.sampledValue.find((s) => s.measurand === 'Energy.Active.Import.Register')
  const energyRaw = num(energySample?.value)
  const energyKwh =
    energyRaw === undefined
      ? undefined
      : energySample?.unit === 'kWh'
        ? energyRaw
        : energyRaw / 1000
  return {
    energyKwh,
    powerW: num(get('Power.Active.Import')),
    currentA: num(get('Current.Import')),
    voltageV: num(get('Voltage')),
    socPct: num(get('SoC')),
  }
}

export interface LatestReadings {
  currentA?: number
  powerW?: number
}

/**
 * Latest live current/power across a whole MeterValues payload (which may carry several
 * MeterValue samples). Current is the max across phases (parseMeterValue only sees the first
 * phase); power is the most recent value. Used to surface live current to the loadpoint/UI.
 */
export function latestReadings(params: MeterValuesReq): LatestReadings {
  const out: LatestReadings = {}
  for (const mv of params.meterValue) {
    const currents = mv.sampledValue
      .filter((s) => s.measurand === 'Current.Import')
      .map((s) => parseFloat(s.value))
      .filter((n) => !isNaN(n))
    if (currents.length > 0) out.currentA = Math.max(...currents)
    const powerRaw = mv.sampledValue.find((s) => s.measurand === 'Power.Active.Import')?.value
    if (powerRaw !== undefined) {
      const p = parseFloat(powerRaw)
      if (!isNaN(p)) out.powerW = p
    }
  }
  return out
}
