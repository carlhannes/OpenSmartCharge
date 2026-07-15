import type { ModuleHealth } from '../../sdk/types.js'

// Pure derivations of OCPP charger state, extracted from the websocket handlers in
// server.ts so they can be unit-tested without a live connection.

/**
 * Maps an OCPP 1.6 connector status to our {charging, connected} flags.
 * - `charging`: the EV is drawing power, or is plugged-in-and-suspended (SuspendedEV/EVSE)
 *   — suspended states still hold a session, so we treat them as charging.
 * - `connected`: a vehicle is present — everything except the idle/out-of-service states
 *   (Available = free, Unavailable = disabled, Faulted = error).
 */
export function computeConnectionState(status: string): { charging: boolean; connected: boolean } {
  const charging = status === 'Charging' || status === 'SuspendedEV' || status === 'SuspendedEVSE'
  const connected = status !== 'Available' && status !== 'Unavailable' && status !== 'Faulted'
  return { charging, connected }
}

/**
 * Auto-start-transaction fires ONCE per plug-in when a vehicle plugs in (`Preparing`) and no
 * transaction is already active, provided the charger has `autoStartTransaction` enabled and it
 * hasn't already auto-started this plug-in (`alreadyAutoStarted` resets on a genuine unplug). The
 * once-per-plug-in guard stops a full car — which cycles Preparing↔Charging with the cable still in —
 * from churning empty transactions; any legitimate re-start after the first is the reconciler's job.
 */
export function shouldAutoStartTransaction(
  status: string,
  hasActiveTransaction: boolean,
  enabled: boolean,
  alreadyAutoStarted: boolean,
): boolean {
  return status === 'Preparing' && !hasActiveTransaction && enabled && !alreadyAutoStarted
}

/**
 * Server-wide module health from station connection counts (the OcppServer is a singleton
 * shared across all ocpp16 chargers). No stations registered → ok (nothing to be unhealthy
 * about); none of the registered stations connected → unavailable; some → degraded; all → ok.
 */
export function computeHealth(registeredStations: number, connectedStations: number): ModuleHealth {
  if (registeredStations === 0) return 'ok'
  if (connectedStations === 0) return 'unavailable'
  return connectedStations >= registeredStations ? 'ok' : 'degraded'
}
