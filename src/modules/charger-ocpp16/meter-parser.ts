import type { MeterValue } from './types.js'

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

  const energyWh = num(get('Energy.Active.Import.Register'))
  return {
    energyKwh: energyWh === undefined ? undefined : energyWh / 1000,
    powerW: num(get('Power.Active.Import')),
    currentA: num(get('Current.Import')),
    voltageV: num(get('Voltage')),
    socPct: num(get('SoC')),
  }
}
