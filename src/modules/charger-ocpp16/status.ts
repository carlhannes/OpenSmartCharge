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
 * Auto-start fires once when a vehicle plugs in (`Preparing`) and no transaction is
 * already active, provided the loadpoint has auto-start enabled.
 */
export function shouldAutoStart(
  status: string,
  hasActiveTransaction: boolean,
  autoStartEnabled: boolean,
): boolean {
  return status === 'Preparing' && !hasActiveTransaction && autoStartEnabled
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
