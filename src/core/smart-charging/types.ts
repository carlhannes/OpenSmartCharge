// Graceful-degradation smart charging: each planner input is produced by a resolver with a
// fallback ladder that ALWAYS returns a usable value. Consumers read only `.value`; `source`
// and `degraded` exist for observability (API / MQTT / logs) — so nothing ever has to branch
// on "is dependency X degraded?".

export interface Resolved<T, R extends string = string> {
  /** Always usable — the value the planner/control loop acts on. */
  value: T
  /** Which ladder rung produced the value. */
  source: R
  /** True when this isn't the top (best-data) rung — i.e. we fell back. */
  degraded: boolean
}

export type EnergyRung = 'soc-capacity' | 'target-kwh' | 'duty-cycle'
export type PriceRung = 'live-tariff' | 'historical-avg' | 'static-night'
export type CurrentRung = 'live-meter' | 'historical-worstcase' | 'static-tod'

/** Local-hour night window [startHour, endHour), wrapping midnight when start > end. */
export interface NightWindow {
  startHour: number
  endHour: number
}
