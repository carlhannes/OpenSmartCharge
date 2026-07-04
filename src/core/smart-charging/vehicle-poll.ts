// Decides WHEN the lifecycle should refresh a vehicle's telemetry. Pure + testable — the module
// itself owns no timer. Vehicle data is only needed on charger-connect (to anchor SoC/range) and
// during active charging (to re-anchor the estimate against reality); never while idle, since
// polling MySkoda too often can wake/drain the car and risk an account lockout.

export interface VehiclePollInput {
  now: number
  connected: boolean
  charging: boolean
  /** ms epoch of the last successful/attempted poll (0 if never). */
  lastPollAt: number
  /** Minimum spacing between polls while charging. */
  intervalMs: number
  /** Whether we've already polled since this connection began. */
  polledThisConnection: boolean
}

export function shouldPollVehicle(i: VehiclePollInput): boolean {
  if (!i.connected) return false // disconnected → nothing to poll
  if (!i.polledThisConnection) return true // first poll on (re)connect: anchor SoC/range
  if (i.charging && i.now - i.lastPollAt >= i.intervalMs) return true // periodic re-anchor
  return false // connected + idle, or too soon → don't wake the car
}
