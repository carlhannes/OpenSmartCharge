import { registerVehicle } from '../../sdk/registry-api.js'
import { VEHICLE_CAPS_NONE, type Vehicle, type VehicleData } from '../../sdk/vehicle.js'

// A "manual" vehicle: a named, user-selected car with NO cloud API — no SoC / range / pluggedIn.
// It exists so a car like an Opel eVivaro is a first-class, SELECTABLE vehicle that can own plans,
// while being honest that we know nothing about it: capabilities are all-false, so it can only
// target kWh, is never polled, and is never auto-identified (only chosen by hand). Its getData()/
// refresh() reject — every consumer already tolerates that (`.catch(() => undefined)`), degrading the
// resolver to the kWh/duty-cycle rung exactly as for a Guest.
registerVehicle({
  type: 'manual',
  label: 'Manual (no app / other car)',
  capabilities: VEHICLE_CAPS_NONE,
  configFields: [],
  create(rawCfg): Vehicle {
    const cfg = rawCfg as { name: string }
    const noTelemetry = (): Promise<VehicleData> =>
      Promise.reject(new Error(`vehicle ${cfg.name}: manual vehicle has no telemetry`))
    return {
      id: cfg.name,
      capabilities: VEHICLE_CAPS_NONE,
      refresh: noTelemetry,
      getData: noTelemetry,
      getCachedCapacity: () => undefined,
      health: () => 'ok',
      stop: async () => {},
    }
  },
})
