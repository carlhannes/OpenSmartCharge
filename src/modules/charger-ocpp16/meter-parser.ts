import type { MeterValue, MeterValuesReq, SampledValue } from './types.js'

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
// OCPP 1.6: a sampled value with no `measurand` IS the energy register (the spec's default).
const measurandOf = (s: SampledValue): string => s.measurand ?? 'Energy.Active.Import.Register'
const sampleOf = (mv: MeterValue, measurand: string): SampledValue | undefined =>
  mv.sampledValue.find((s) => measurandOf(s) === measurand)

function num(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = parseFloat(raw)
  return isNaN(n) ? undefined : n
}

// The energy register defaults to Wh and power to W, but chargers may report kWh / kW and say so via
// `unit`. Respect the declared unit — otherwise a kWh reading is 1000× too small (corrupting the
// session-energy delta) and a kW reading shows ~7 W for a 7 kW charge.
function energyKwhOf(s: SampledValue | undefined): number | undefined {
  const n = num(s?.value)
  return n === undefined ? undefined : s?.unit === 'kWh' ? n : n / 1000
}
function powerWOf(s: SampledValue | undefined): number | undefined {
  const n = num(s?.value)
  return n === undefined ? undefined : s?.unit === 'kW' ? n * 1000 : n
}

export function parseMeterValue(mv: MeterValue): ParsedMeterValue {
  return {
    energyKwh: energyKwhOf(sampleOf(mv, 'Energy.Active.Import.Register')),
    powerW: powerWOf(sampleOf(mv, 'Power.Active.Import')),
    currentA: num(sampleOf(mv, 'Current.Import')?.value),
    voltageV: num(sampleOf(mv, 'Voltage')?.value),
    socPct: num(sampleOf(mv, 'SoC')?.value),
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
      .filter((s) => measurandOf(s) === 'Current.Import')
      .map((s) => parseFloat(s.value))
      .filter((n) => !isNaN(n))
    if (currents.length > 0) out.currentA = Math.max(...currents)
    const p = powerWOf(sampleOf(mv, 'Power.Active.Import'))
    if (p !== undefined) out.powerW = p
  }
  return out
}
