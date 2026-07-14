// Pure decision: which vehicle is actually present on a loadpoint this session — the bound car, or a
// guest (null)? The lifecycle recomputes this each control tick and, when the answer is NOT the bound
// car, suppresses that car's SoC so a guest isn't charged against the wrong car's SoC/target (it
// degrades to the kWh target / duty-cycle). A persisted per-session `override` lets the user force the
// answer when auto-detection can't tell (e.g. the bound car is plugged in elsewhere, so its cloud API
// reports pluggedIn=true while a guest charges here).

/** Persisted per-session override. `undefined` = auto-detect; `'guest'` = force guest; `'vehicle'` =
 *  force the bound car (the recourse when the car API wrongly reports unplugged). Reset on unplug. */
export type GuestOverride = 'guest' | 'vehicle' | undefined

export interface ActiveVehicleInput {
  /** The loadpoint's configured vehicle name, or undefined if none is bound. */
  boundVehicle: string | undefined
  /** The charger reports a car connected (OCPP status not Available/Unavailable/Faulted). */
  connected: boolean
  /** The bound vehicle's own view of whether it's plugged in; `undefined` when unknown (poll/air-con
   *  call failed). */
  pluggedIn: boolean | undefined
  override: GuestOverride
}

/**
 * The vehicle present on this loadpoint this session: the bound car's name, or `null` (guest).
 *
 * Stability-first — only declare "guest" on POSITIVE evidence the bound car is absent (the charger
 * sees a car AND the bound car explicitly reports `pluggedIn === false`). An unknown plug state
 * (`undefined`) trusts the binding, so a failed poll never guests-out a real session.
 */
export function resolveActiveVehicle(i: ActiveVehicleInput): string | null {
  if (!i.boundVehicle) return null // nothing bound → no SoC source anyway → guest
  if (i.override === 'guest') return null
  if (i.override === 'vehicle') return i.boundVehicle
  // auto: the bound car is absent only when the charger sees a car but that car says "not me".
  if (i.connected && i.pluggedIn === false) return null
  return i.boundVehicle
}
