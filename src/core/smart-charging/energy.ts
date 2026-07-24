import { chargeRateKW, DEFAULT_CHARGING_EFFICIENCY, DUTY_CYCLE_FALLBACK } from '../electrical.js'
import type { PlanUnit } from '../plans.js'
import type { Resolved, EnergyRung } from './types.js'
import type { VehicleCapabilities } from '../../sdk/vehicle.js'

/** A user target: an amount (`value`) in one of three units. `pct`/`km` are absolute battery
 *  STATES (need live SoC); `kwh` is relative energy-to-add (charger-measured, no car needed). */
export interface Target {
  unit: PlanUnit
  value: number
}

/** What a loadpoint's data sources report right now — the vehicle today; a charger reading SoC over
 *  the Type-2 wire in future. All optional; absence is the degradation signal. `soc`/`range` are
 *  paired (from one reading); `capacity` is the battery's usable kWh. */
export interface EnergyReading {
  soc?: number
  range?: number
  capacity?: number
}

/**
 * The single place a target becomes an absolute SoC% — used both for display (the ring / "≈N%") and
 * as the charging target. `pct`→value, `km`→value ÷ (range/soc) (the car's own km-per-% ratio),
 * `kwh`→null (an energy amount isn't a battery state). Null when the reading can't back it.
 */
export function targetToSoc(target: Target, reading: EnergyReading): number | null {
  if (target.unit === 'pct') return target.value
  if (target.unit === 'kwh') return null
  const { range, soc } = reading
  if (range == null || soc == null || soc <= 0 || range <= 0) return null
  return Math.min(100, target.value / (range / soc))
}

/** Target units a loadpoint can actually back right now. `kwh` is always possible (the charger
 *  meters kWh); `pct` needs SoC + capacity to size and estimate; `km` additionally needs range. */
export function availableUnits(reading: EnergyReading): PlanUnit[] {
  const hasCap = reading.capacity != null && reading.capacity > 0
  const hasSoc = reading.soc != null
  const units: PlanUnit[] = []
  if (hasSoc && hasCap) units.push('pct')
  if (hasSoc && hasCap && reading.range != null) units.push('km')
  units.push('kwh')
  return units
}

/** Target units a vehicle CAN back, derived from its declared CAPABILITIES (type-based — what the
 *  module fundamentally supports, for the plan editor). Mirror of availableUnits, over capabilities
 *  rather than a live reading; the resolver still degrades gracefully when live data is momentarily
 *  absent. A plan targeting several vehicles offers the intersection of their targetUnitsFor. */
export function targetUnitsFor(caps: VehicleCapabilities): PlanUnit[] {
  const units: PlanUnit[] = []
  if (caps.soc && caps.capacity) units.push('pct')
  if (caps.soc && caps.capacity && caps.range) units.push('km')
  units.push('kwh')
  return units
}

/** A vehicle is eligible for identify-on-plug iff it reports cable presence (its own pluggedIn). */
export function autoIdentifiable(caps: VehicleCapabilities): boolean {
  return caps.presence
}

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

export interface TargetContext extends EnergyReading {
  /** Estimated SoC now (%) from the estimator (anchor + kWh delivered since). Distinct from
   *  `reading.soc`, which is the last raw car reading, used only for the km ratio. */
  estimatedSocPct?: number
  sessionEnergyKWh: number
  hoursUntilTarget: number
  maxCurrentA: number
  phases: number
  efficiency?: number
  dutyCycle?: number
}

export interface ResolvedTarget {
  /** Grid-side kWh the planner must still deliver. */
  requiredKWh: number
  /** Absolute target SoC% for display (ring / "≈N%"); null for kwh targets or when unbackable. */
  resolvedSoc: number | null
  source: EnergyRung
  degraded: boolean
}

/**
 * Single entry point: turn a target into what the planner consumes. Owns unit conversion (via
 * targetToSoc) and delegates the energy math to the proven resolveEnergyTarget ladder — so charging
 * behaviour is unchanged. A `null` target (no plan, no ad-hoc) → the duty-cycle rung. Also returns
 * resolvedSoc, the single value the UI displays for the target.
 */
export function resolveTarget(target: Target | null, ctx: TargetContext): ResolvedTarget {
  const resolvedSoc = target ? targetToSoc(target, ctx) : null
  const energy = resolveEnergyTarget({
    estimatedSocPct: ctx.estimatedSocPct,
    targetSocPct: resolvedSoc ?? undefined,
    batteryCapacityKWh: ctx.capacity,
    targetKWh: target?.unit === 'kwh' ? target.value : undefined,
    sessionEnergyKWh: ctx.sessionEnergyKWh,
    hoursUntilTarget: ctx.hoursUntilTarget,
    maxCurrentA: ctx.maxCurrentA,
    phases: ctx.phases,
    efficiency: ctx.efficiency,
    dutyCycle: ctx.dutyCycle,
  })
  return {
    requiredKWh: energy.value,
    resolvedSoc,
    source: energy.source,
    degraded: energy.degraded,
  }
}
