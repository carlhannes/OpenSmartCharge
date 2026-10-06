// Decides WHEN the lifecycle should refresh a vehicle's telemetry. Pure + testable — the module
// itself owns no timer. We poll on charger-connect (to anchor SoC/range), then on two cadences while
// PLUGGED IN: a slow one while actively drawing (re-anchor the estimate against delivered energy) and
// a faster one while connected-but-idle/paused (catch climate/plug changes the estimate can't show).
// Never while UNPLUGGED — polling a parked car too often can wake/drain it and risk an account lockout.

export interface VehiclePollInput {
  now: number
  connected: boolean
  /** Actually pulling current now (currentA > 0) — distinguishes active charging from a
   * plugged-but-idle/paused car; the two poll on different cadences. */
  drawing: boolean
  /** ms epoch of the last successful/attempted poll (0 if never). */
  lastPollAt: number
  /** Spacing while actively drawing (re-anchor the estimate against delivered energy). */
  chargingIntervalMs: number
  /** Spacing while connected but idle/paused (catch climate/plug changes; estimate isn't moving). */
  idleIntervalMs: number
  /** Whether we've already polled since this connection began. */
  polledThisConnection: boolean
}

export function shouldPollVehicle(i: VehiclePollInput): boolean {
  if (!i.connected) return false // unplugged → never poll (don't wake a parked car)
  if (!i.polledThisConnection) return true // first poll on (re)connect: anchor SoC/range
  const interval = i.drawing ? i.chargingIntervalMs : i.idleIntervalMs
  return i.now - i.lastPollAt >= interval // periodic re-anchor (drawing) or climate/plug watch (idle)
}

/**
 * Which vehicles' poll state to reset when a loadpoint is unplugged. Poll state is kept PER VEHICLE
 * and shared by every loadpoint, so the reset must fire only on this loadpoint's connected→unplugged
 * EDGE (not on every tick it stays unplugged) and must spare a car another plugged-in loadpoint is
 * using — otherwise one idle charger re-arms "first poll on connect" for the other's car every tick,
 * polling it every control interval and defeating its failure backoff.
 */
export function vehiclesToResetOnUnplug(i: {
  wasConnected: boolean
  connected: boolean
  candidates: string[]
  /** Active vehicles of OTHER loadpoints that are plugged in right now. */
  inUseElsewhere: ReadonlySet<string>
}): string[] {
  if (i.connected || !i.wasConnected) return []
  return i.candidates.filter((name) => !i.inUseElsewhere.has(name))
}
