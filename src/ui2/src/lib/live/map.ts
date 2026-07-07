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
  mode: "off" | "smart" | "fast";
}): ChargerRuntimeStatus {
  if (!lp.connected) return "unplugged";
  if (lp.charging) return lp.mode === "fast" ? "fast_charging" : "charging";
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
    status: deriveStatus({ connected: lp.connected, charging: lp.charging, mode }),
    activeVehicleId: boundVehicle,
    currentPowerW: Math.round(lp.currentA * VOLTAGE),
    sessionKwh: lp.sessionEnergyKWh,
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
    resolvedSoc: dto.resolvedSoc,
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
