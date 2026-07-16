// Pure mappers: backend API DTOs → the existing zustand store shapes.
// Kept side-effect-free so they're easy to reason about (and unit-test later).
import type { ChargerRuntimeStatus } from "@/lib/copy";
import type {
  Charger,
  Vehicle,
  Session,
  Plan,
  ModuleHealth as StoreHealth,
} from "@/lib/mock/store";
import type {
  LoadpointStateDto,
  LoadpointPlanDto,
  PlanDto,
  SiteDto,
  VehicleStateDto,
  TariffSlotDto,
  TransactionDto,
  ModuleHealth,
  ChargeMode,
} from "@/lib/api/rest";

const VOLTAGE = 230; // assumed phase voltage for the amps→watts display estimate

export const mapMode = (m: ChargeMode): "off" | "smart" | "fast" => (m === "disabled" ? "off" : m);

export function deriveStatus(lp: {
  connected: boolean;
  charging: boolean;
  /** Actually pulling power now (currentA above ~0). A charging-family OCPP session can be open but
   *  drawing 0 A (suspended: paused for a cheap window, or done at target) — that is NOT "charging". */
  drawing: boolean;
  mode: "off" | "smart" | "fast";
  /** Backend-resolved session-complete (a real target met, or the car stopped itself after
   *  delivering). The backend owns this — the client can't tell "done" from "paused" from draw alone. */
  finished: boolean;
}): ChargerRuntimeStatus {
  if (!lp.connected) return "unplugged";
  // Only "charging" when the car is genuinely drawing — and a drawing car wins over a stale finished
  // flag (correctness first). An open-but-0 A session (SuspendedEV) is NOT "charging".
  if (lp.charging && lp.drawing) return lp.mode === "fast" ? "fast_charging" : "charging";
  // Backend says the session is done (target reached / car full) → "Ready", ahead of the paused states
  // — this is what tells "done" apart from "paused for a cheap window" / "waiting for a mode".
  if (lp.finished) return "ready";
  if (lp.mode === "off") return "off";
  if (lp.mode === "smart") return "waiting_cheap";
  return "plugged_paused";
}

export function mapLoadpoint(lp: LoadpointStateDto, site?: SiteDto): Charger {
  const mode = mapMode(lp.mode);
  const siteLp = site?.loadpoints.find((l) => l.name === lp.name);
  const boundVehicle = siteLp?.vehicle ?? null;
  // Display name = the charger's cosmetic label (falls back to the immutable name); id stays the key.
  const label = site?.chargers.find((c) => c.name === (siteLp?.charger ?? lp.name))?.label;
  return {
    id: lp.name,
    name: label ?? lp.name,
    maxAmps: lp.maxCurrentA,
    mode,
    status: deriveStatus({
      connected: lp.connected,
      charging: lp.charging,
      drawing: (lp.currentA ?? 0) > 0.5,
      mode,
      finished: lp.sessionComplete ?? false,
    }),
    finished: lp.sessionComplete ?? false,
    // Raw status inputs kept so a later loadpoint.session SSE (which carries only the finished flag)
    // can recompute status without re-deriving these.
    connected: lp.connected,
    charging: lp.charging,
    drawingA: lp.currentA ?? 0,
    // Resolved active vehicle from the backend (Guest = null); fall back to the static binding until
    // the first tick populates it. boundVehicleId keeps the static binding for the UI's tab set.
    activeVehicleId: lp.activeVehicle !== undefined ? lp.activeVehicle : boundVehicle,
    boundVehicleId: boundVehicle,
    vehicleOverride: lp.vehicleOverride ?? null,
    // Power comes from the backend (3-phase MeterValues), NOT recomputed single-phase here.
    currentPowerW: lp.powerW ?? Math.round(lp.currentA * VOLTAGE),
    // Session total = the peak-hold delivered kWh (survives the transaction churn); the live
    // per-transaction value is the fallback until the first tick populates deliveredKWh.
    sessionKwh: lp.deliveredKWh ?? lp.sessionEnergyKWh,
    sessionStart: null,
    guestTargetKwh: lp.targetKWh ?? null,
    minSoc: lp.minSoc ?? null,
    constraintAmps: null, // filled from the balancer allocation, not the loadpoint
    availableTargetUnits: lp.availableTargetUnits ?? ["pct", "km", "kwh"],
  };
}

export function mapPlan(dto: PlanDto): Plan {
  return {
    id: dto.id,
    chargerId: dto.loadpointName,
    days: dto.days,
    readyBy: dto.readyBy,
    target: dto.target,
    unit: dto.unit,
    enabled: dto.enabled,
    vehicles: dto.vehicles ?? [],
    pauseOnTarget: dto.pauseOnTarget ?? true,
    resolvedSoc: dto.resolvedSoc,
  };
}

// The charger "price & plan" chart data, in epoch-ms so the chart maps everything onto one time axis
// (fixes the old clock-hour-bucket axis). `charge` slots are the backend planner's real selection.
export interface MappedLoadpointPlan {
  readyByMs: number | null;
  fromMs: number;
  toMs: number;
  slots: { startMs: number; endMs: number; price: number; charge: boolean }[];
}

export function mapLoadpointPlan(dto: LoadpointPlanDto): MappedLoadpointPlan {
  return {
    readyByMs: dto.readyBy ? Date.parse(dto.readyBy) : null,
    fromMs: Date.parse(dto.window.from),
    toMs: Date.parse(dto.window.to),
    slots: dto.slots.map((s) => ({
      startMs: Date.parse(s.start),
      endMs: Date.parse(s.end),
      price: s.pricePerKWh,
      charge: s.shouldCharge,
    })),
  };
}

export function mapVehicle(name: string, dto: VehicleStateDto): Vehicle {
  const d = dto.data;
  return {
    id: name,
    name,
    brand: "", // no brand field on the API
    soc: d?.soc ?? 0,
    rangeKm: Math.round(d?.range ?? 0),
    batteryKwh: dto.capacityKWh ?? d?.batteryCapacity ?? 0,
    connected: d?.pluggedIn ?? false,
    climateOn: d?.climateActive,
    // Capabilities from the backend (self-reported by the module). Default to full telemetry when
    // absent (demo / older backend) so the UI stays functional.
    targetUnits: dto.targetUnits ?? ["pct", "km", "kwh"],
    hasTelemetry: dto.capabilities?.soc ?? true,
  };
}

/** Whole-house watts from a meter reading/snapshot: prefer powerW, else Σ phase currents × voltage.
 *  (Sum, not max — total consumption ≈ 230 V × (i1+i2+i3); max-phase is for breaker headroom, not power.) */
export function mapMeterWatts(
  m: { powerW?: number; i1A?: number; i2A?: number; i3A?: number } | null | undefined,
): number | null {
  if (!m) return null;
  if (m.powerW != null) return Math.round(m.powerW);
  const phases = [m.i1A, m.i2A, m.i3A].filter((a): a is number => a != null);
  return phases.length ? Math.round(phases.reduce((a, b) => a + b, 0) * VOLTAGE) : null;
}

export function mapHealth(rec: Record<string, ModuleHealth>): StoreHealth[] {
  const toStatus = (h: ModuleHealth): StoreHealth["status"] =>
    h === "ok" ? "ok" : h === "degraded" ? "warn" : "bad";
  return Object.entries(rec).map(([id, h]) => ({ id, name: id, status: toStatus(h), message: "" }));
}

/** Bucket tariff slots into the 24-hour-of-day number[] the Timeline consumes; fill gaps with the mean. */
export function mapPrices(slots: TariffSlotDto[]): number[] {
  const prices = new Array<number>(24).fill(NaN);
  for (const s of slots) prices[new Date(s.start).getHours()] = s.pricePerKWh;
  const known = prices.filter((p) => !Number.isNaN(p));
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0.15;
  return prices.map((p) => (Number.isNaN(p) ? avg : p));
}

export function currencySymbol(code: string | undefined): string {
  if (!code) return "€";
  const map: Record<string, string> = {
    EUR: "€",
    SEK: "kr",
    NOK: "kr",
    DKK: "kr",
    USD: "$",
    GBP: "£",
  };
  return map[code] ?? code;
}

export function mapTransactions(rows: TransactionDto[]): Session[] {
  return rows.map((r) => ({
    id: String(r.id),
    chargerId: r.loadpoint_name,
    vehicleName: "", // API stores no vehicle name on the transaction
    startedAt: Date.parse(r.start_time),
    endedAt: r.end_time ? Date.parse(r.end_time) : Date.parse(r.start_time),
    kwh: r.energy_kwh ?? 0,
    costEur: 0, // API stores no cost — History renders this as "—"
  }));
}
