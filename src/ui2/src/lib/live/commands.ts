// Live/demo command router. In live mode these hit the backend (with an optimistic local
// store update where it helps); in demo mode they fall back to local/simulated behavior.
import { useOsc, type Mode, type Plan, type Vehicle } from "@/lib/mock/store";
import type { VehicleCapabilitiesDto } from "@/lib/api/rest";
import * as api from "@/lib/api/rest";

// Demo mirror of the backend targetUnitsFor(caps) (smart-charging/energy.ts): kWh always; pct needs
// SoC+capacity; km additionally needs range. Live mode gets targetUnits straight from the backend DTO.
function demoTargetUnits(caps?: VehicleCapabilitiesDto): Vehicle["targetUnits"] {
  const units: Vehicle["targetUnits"] = [];
  if (caps?.soc && caps.capacity) units.push("pct");
  if (caps?.soc && caps.capacity && caps.range) units.push("km");
  units.push("kwh");
  return units;
}

const isLive = () => useOsc.getState().source === "live";
const toApiMode = (m: Mode): api.ChargeMode => (m === "off" ? "disabled" : m);

/** Mode change: optimistic local update; POST when live (SSE `loadpoint.mode` reconciles). */
export async function changeMode(chargerId: string, mode: Mode): Promise<void> {
  useOsc.getState().setMode(chargerId, mode);
  if (isLive()) await api.setMode(chargerId, toApiMode(mode));
}

/** One-shot amp limit: optimistic local update; POST /profile when live. */
export async function applyOneShot(chargerId: string, amps: number): Promise<void> {
  useOsc.getState().oneShotAmps(chargerId, amps);
  if (isLive()) await api.setProfile(chargerId, amps);
}

/** OCPP command buttons. Throws on API error so the ActionButton surfaces the failure. */
export async function runCommand(chargerId: string, label: string): Promise<void> {
  if (!isLive()) {
    await new Promise((r) => setTimeout(r, 600)); // demo: simulate a round-trip
    return;
  }
  switch (label) {
    case "Start":
      await api.remoteStart(chargerId);
      return;
    case "Stop":
      await api.remoteStop(chargerId);
      return;
    case "Soft reset":
      await api.resetCharger(chargerId, "Soft");
      return;
    case "Hard reset":
      await api.resetCharger(chargerId, "Hard");
      return;
    case "Clear profile":
      await api.clearProfile(chargerId);
      return;
    default:
      return;
  }
}

/** View composite schedule (a read). Demo returns illustrative text; live returns the real JSON. */
export async function viewComposite(chargerId: string): Promise<string> {
  if (!isLive()) {
    return "00:00–06:00 · max A\n06:00–09:00 · 6 A\n09:00–24:00 · max A";
  }
  const result = await api.getCompositeSchedule(chargerId, 3600);
  return JSON.stringify(result, null, 2);
}

// The editable subset of a Plan (never touches id/chargerId) — maps 1:1 onto PlanDto fields.
type PlanPatch = Partial<
  Pick<Plan, "days" | "readyBy" | "target" | "unit" | "enabled" | "vehicles" | "pauseOnTarget">
>;

/** Add a plan: optimistic local (temp id); POST when live. `vehicles` attaches it to a target set
 *  (e.g. the charger's active car). The `loadpoint.plans` SSE re-fetch replaces the temp row with the
 *  authoritative one (real id) — self-healing. */
export async function addPlan(chargerId: string, vehicles: string[] = []): Promise<void> {
  const p = useOsc.getState().addPlan(chargerId);
  if (vehicles.length) useOsc.getState().updatePlan(p.id, { vehicles });
  if (isLive()) {
    await api.createPlan(chargerId, {
      days: p.days,
      readyBy: p.readyBy,
      target: p.target,
      unit: p.unit,
      enabled: p.enabled,
      vehicles,
      pauseOnTarget: p.pauseOnTarget,
    });
  }
}

export async function updatePlan(planId: string, patch: PlanPatch): Promise<void> {
  const plan = useOsc.getState().plans.find((p) => p.id === planId);
  useOsc.getState().updatePlan(planId, patch);
  if (isLive() && plan) await api.updatePlanApi(plan.chargerId, planId, patch);
}

export async function removePlan(planId: string): Promise<void> {
  const plan = useOsc.getState().plans.find((p) => p.id === planId); // capture before removing
  useOsc.getState().removePlan(planId);
  if (isLive() && plan) await api.deletePlan(plan.chargerId, planId);
}

/** minSoc floor: optimistic patch; COALESCE-merged POST /target when live. */
export async function setMinSoc(chargerId: string, pct: number): Promise<void> {
  useOsc.getState().patchCharger(chargerId, { minSoc: pct });
  if (isLive()) await api.setTarget(chargerId, { minSoc: pct });
}

/** Sticky active-vehicle override: null = Auto (identify decides), 'guest' = force Guest, or a vehicle
 *  id = force it. Optimistically sets the override (drives the picker highlight) + a resolved-display
 *  guess; the `loadpoint.activeVehicle` SSE reconciles the resolved value. */
export async function setActiveVehicle(chargerId: string, override: string | null): Promise<void> {
  const resolved = override === "guest" ? null : override; // Auto/Guest → guest-ish display until SSE
  useOsc
    .getState()
    .patchCharger(chargerId, { vehicleOverride: override, activeVehicleId: resolved });
  if (isLive()) await api.setLoadpointVehicle(chargerId, override);
}

/** Add a vehicle. Generic over the type's descriptor — `fields` are the type's config values (from
 *  <VehicleForm>). Live: POST /api/vehicles (the `config.changed` SSE → rehydrateSite adds it). Demo:
 *  build a store Vehicle, deriving telemetry/units from the type's declared capabilities. */
export async function addVehicle(v: {
  name: string;
  type: string;
  fields: Record<string, string>;
}): Promise<void> {
  if (isLive()) {
    await api.addVehicle(v);
    return;
  }
  const t = useOsc.getState().vehicleTypes.find((x) => x.type === v.type);
  useOsc.getState().addVehicle({
    name: v.name,
    brand: (t?.label ?? "").split(/[/(]/)[0].trim(),
    type: v.type,
    vin: v.fields.vin,
    soc: 0,
    rangeKm: 0,
    batteryKwh: 0,
    connected: false,
    targetUnits: demoTargetUnits(t?.capabilities),
    hasTelemetry: !!t?.capabilities?.soc,
  });
}

/** Edit a vehicle's config/credentials. `id` is the vehicle name in live (immutable key). Live: PUT
 *  /api/vehicles/:name (a blank field keeps the stored value). Demo: reflect the one client-visible
 *  field (vin) on the store Vehicle — creds aren't stored client-side. */
export async function updateVehicle(id: string, fields: Record<string, string>): Promise<void> {
  if (isLive()) {
    await api.updateVehicle(id, fields);
    return;
  }
  const patch: Partial<Vehicle> = {};
  if (fields.vin) patch.vin = fields.vin;
  useOsc.getState().updateVehicle(id, patch);
}

/** Remove a vehicle. Live: DELETE (config.changed → rehydrateSite drops it); demo: store remove. */
export async function removeVehicle(id: string): Promise<void> {
  if (isLive()) {
    await api.deleteVehicle(id);
    return;
  }
  useOsc.getState().removeVehicle(id);
}

/** Guest kWh target ("just charge" when null → clears the cap): optimistic; POST /target { kwh }
 *  when live. The `loadpoint.target` SSE reconciles. */
export async function setGuestTarget(chargerId: string, kwh: number | null): Promise<void> {
  useOsc.getState().setGuestTarget(chargerId, kwh);
  if (isLive()) await api.setTarget(chargerId, { kwh });
}

/** Site timezone: optimistic local; PUT /settings when live (SSE `settings.changed` reconciles). */
export async function setTimezone(tz: string): Promise<void> {
  useOsc.getState().setTimezone(tz);
  if (isLive()) await api.setSettings({ timezone: tz });
}

/** Region (tariff zone): optimistic; PUT /api/tariffs/:name when live (SSE `config.changed` reconciles). */
export async function setRegion(zone: string): Promise<void> {
  useOsc.getState().setConfig({ region: zone });
  const tariffName = useOsc.getState().config.tariffName;
  if (isLive() && tariffName) await api.setTariffZone(tariffName, zone);
}

/** Main breaker (site-level): optimistic; PUT /api/site when live. */
export async function setBreaker(amps: number): Promise<void> {
  useOsc.getState().setConfig({ breakerAmps: amps });
  if (isLive()) await api.setSiteBreaker(amps);
}

/** Charger max current: optimistic; PUT /api/chargers/:name when live (charger id == charger name). */
export async function setChargerMaxAmps(chargerId: string, maxA: number): Promise<void> {
  useOsc.getState().setChargerMaxAmps(chargerId, maxA);
  if (isLive()) await api.updateChargerApi(chargerId, { maxA });
}

/** Charger display label (rename): optimistic; PUT /api/chargers/:name {label} when live. */
export async function renameCharger(chargerId: string, label: string): Promise<void> {
  useOsc.getState().renameCharger(chargerId, label);
  if (isLive()) await api.updateChargerApi(chargerId, { label });
}
