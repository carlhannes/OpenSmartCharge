// Electrical constants and charge-rate math, kept in one place so the planner,
// estimator, and lifecycle share a single source of truth for these values.

/** Nominal AC grid voltage (V) — single phase, European/Swedish grid. */
export const GRID_VOLTAGE_V = 230

/** Typical AC charging efficiency: energy into the battery / energy drawn from the grid. */
export const DEFAULT_CHARGING_EFFICIENCY = 0.92

/**
 * Duty-cycle assumption for the no-SoC fallback: when we can't read the vehicle's
 * state of charge we assume it draws ~40% of the theoretical maximum over the window.
 */
export const DUTY_CYCLE_FALLBACK = 0.4

/** Theoretical maximum charge power (kW) for a current limit and phase count. */
export function chargeRateKW(maxCurrentA: number, phases: number): number {
  return (maxCurrentA * phases * GRID_VOLTAGE_V) / 1000
}
