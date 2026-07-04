import { chargeRateKW, DEFAULT_CHARGING_EFFICIENCY, DUTY_CYCLE_FALLBACK } from '../electrical.js'
import type { Resolved, EnergyRung } from './types.js'

export interface EnergyInputs {
  /** Estimated SoC now (%) — from estimateSoc(cachedSoc, sessionEnergyKWh, capacity). */
  estimatedSocPct?: number
  targetSocPct?: number
  batteryCapacityKWh?: number
  /** Fixed kWh-to-add target (guest/no-SoC fallback). */
  targetKWh?: number
  /** kWh delivered so far this session (makes targetKWh converge). */
  sessionEnergyKWh: number
  hoursUntilTarget: number
  maxCurrentA: number
  phases: number
  efficiency?: number
  dutyCycle?: number
}

/**
 * Resolve how many kWh still need to be added, degrading:
 *  1. soc-capacity  — real SoC + target + battery capacity (the accurate path)
 *  2. target-kwh    — a fixed kWh-to-add target, session-relative so it converges & stops
 *  3. duty-cycle    — assume ~40% duty over the remaining window (no vehicle info at all)
 */
export function resolveEnergyTarget(i: EnergyInputs): Resolved<number, EnergyRung> {
  const efficiency = i.efficiency ?? DEFAULT_CHARGING_EFFICIENCY

  if (i.estimatedSocPct != null && i.batteryCapacityKWh && i.targetSocPct != null) {
    const remainingPct = Math.max(0, i.targetSocPct - i.estimatedSocPct)
    const kWh = ((remainingPct / 100) * i.batteryCapacityKWh) / efficiency
    return { value: Math.max(0, kWh), source: 'soc-capacity', degraded: false }
  }

  if (i.targetKWh != null) {
    return {
      value: Math.max(0, i.targetKWh - i.sessionEnergyKWh),
      source: 'target-kwh',
      degraded: true,
    }
  }

  const rateKW = chargeRateKW(i.maxCurrentA, i.phases)
  const dutyCycle = i.dutyCycle ?? DUTY_CYCLE_FALLBACK
  return {
    value: Math.max(1, i.hoursUntilTarget * rateKW * dutyCycle),
    source: 'duty-cycle',
    degraded: true,
  }
}
