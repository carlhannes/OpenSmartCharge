// Pure decision: which vehicle is actually present on a loadpoint this session — one of the
// configured candidates, or a guest (null)? The lifecycle recomputes this each control tick over ALL
// configured vehicles and, when the answer is NOT a real car (guest), suppresses car telemetry so the
// resolver degrades to the kWh target / duty-cycle.
//
// Identity ladder (see the plan): (1) a single app-car POSITIVELY claiming the plug (its own API says
// pluggedIn) wins — even over a stale sticky override (the lifecycle then clears the superseded
// override = "auto-detected another vehicle"); (2) the sticky manual override (a manual/API-less car,
// Guest, or a forced app-car), which persists across unplugs; (3) auto fallback (single-candidate
// trust — preserving today's single-car behavior — or the session latch); (4) Guest.
//
// A charger-reported hard EV id (VIN/EVCCID/idTag over OCPP 2.0) is a HIGHER-priority signal than
// vehicle presence — it's a designed seam (ChargerStatus.evId) resolved upstream in the lifecycle,
// which passes the matched vehicle as a definitive `override` here. This function stays presence-based.

/** The reserved override value meaning "force Guest" (distinct from any vehicle name). */
export const GUEST = 'guest'

/** Sticky per-session override: `'guest'` = force guest, a vehicle name = force that car, `undefined`
 *  = auto-detect. Persisted (guest_override column); reset only on supersede/manual change, not unplug. */
export type VehicleOverride = string | undefined

export interface ActiveVehicleInput {
  /** All configured vehicles eligible as candidates on this loadpoint (typically every configured
   *  vehicle; legacy single `loadpoint.vehicle` → just that one). */
  candidates: string[]
  /** A car is present on the charger (OCPP status not Available/Unavailable/Faulted). */
  connected: boolean
  /** Per-candidate cable view from each vehicle's OWN API. Absent/undefined = unknown (poll not done
   *  or failed, or a manual vehicle with no telemetry). Only app vehicles ever report `true`/`false`. */
  readings: Record<string, { pluggedIn?: boolean } | undefined>
  override: VehicleOverride
  /** The previous tick's resolved active vehicle (session latch), or null. */
  latched: string | null
}

/** The single app-car positively reporting it's plugged in, or null (zero or ambiguous ≥2 claims).
 *  Exposed so the lifecycle can decide when an auto-detection should supersede a sticky override. */
export function positiveClaimant(
  candidates: string[],
  readings: ActiveVehicleInput['readings'],
): string | null {
  const claimants = candidates.filter((c) => readings[c]?.pluggedIn === true)
  return claimants.length === 1 ? claimants[0] : null
}

/**
 * The vehicle present on this loadpoint this session: a candidate's name, or `null` (guest).
 *
 * Stability-first — a positive claim (exactly one candidate's own API says `pluggedIn === true`) is
 * the only auto signal strong enough to override a manual pick; everything else honors the sticky
 * override, then falls back conservatively (a lone candidate is trusted unless it positively reports
 * unplugged — preserving the single-car behavior; otherwise the latch holds until a car positively
 * leaves; else guest).
 */
export function resolveActiveVehicle(i: ActiveVehicleInput): string | null {
  if (!i.connected) return null // no live session

  // (1) A single positive app-claim wins — even over a stale sticky override.
  const claim = positiveClaimant(i.candidates, i.readings)
  if (claim) return claim

  // (2) Sticky manual override (persists across unplug; only a claim above, or a manual change, clears it).
  if (i.override === GUEST) return null
  if (i.override !== undefined) return i.candidates.includes(i.override) ? i.override : null

  // (3) Auto, no override, no single claim.
  const claimants = i.candidates.filter((c) => i.readings[c]?.pluggedIn === true)
  if (claimants.length > 1) {
    // Ambiguous (≥2 cars report plugged — one likely elsewhere): keep the latch if still claiming, else guest.
    return i.latched && claimants.includes(i.latched) ? i.latched : null
  }
  if (i.candidates.length === 1) {
    // Single-candidate back-compat: trust the lone car unless it POSITIVELY reports unplugged.
    return i.readings[i.candidates[0]]?.pluggedIn === false ? null : i.candidates[0]
  }
  // Multi-candidate, nobody claiming: hold the latched car unless it positively left; else guest.
  if (i.latched && i.candidates.includes(i.latched) && i.readings[i.latched]?.pluggedIn !== false) {
    return i.latched
  }
  return null // guest
}
