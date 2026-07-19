// REST client for the OpenSmartCharge backend — mirrors src/ui/client/rest.ts.
// Relative `/api` paths; works via the Vite dev proxy (dev) or same-origin (prod).
// Over-the-wire shapes: Dates are serialized as ISO strings; omitted optionals are absent.
import type { DayKey } from "@/lib/format";

export type ModuleHealth = "ok" | "degraded" | "unavailable";
export type ChargeMode = "disabled" | "smart" | "fast";

export interface LoadpointStateDto {
  name: string;
  mode: ChargeMode;
  targetSoc?: number;
  targetTime?: string;
  targetKWh?: number;
  minSoc?: number;
  connected: boolean;
  charging: boolean;
  currentA: number;
  powerW: number; // instantaneous draw (W) from MeterValues; 0 when not charging
  sessionEnergyKWh: number;
  maxCurrentA: number;
  /** kWh delivered this plug-in, peak-held across the OCPP transaction churn — the session total to
   *  display (survives the empty-session churn that zeroes sessionEnergyKWh). Undefined pre-first-tick. */
  deliveredKWh?: number;
  /** The session has completed — a real SoC/%/km target was met, or the car stopped accepting charge
   *  on its own after delivering energy. Drives the UI "Ready" state. Undefined pre-first-tick. */
  sessionComplete?: boolean;
  /** Resolved vehicle present this session: the bound car's name, or null (guest); undefined pre-first-tick. */
  activeVehicle?: string | null;
  // The sticky manual override: undefined/null = Auto (identify decides), 'guest', or a vehicle name.
  vehicleOverride?: string | null;
  availableTargetUnits?: PlanDto["unit"][]; // units the data can back now (kwh always; pct/km need car data)
  resolve?: LoadpointResolveDto; // latest control-loop decision (the "why"); undefined until first tick
}

// The control loop's per-tick decision: whether to charge now, the circuit budget it's splitting, and
// which ladder rung each resolver fell back to. Mirrors src/core/loadpoint.ts LoadpointState.resolve.
// Also arrives live via the `loadpoint.resolve` SSE event as `{ name, ...LoadpointResolveDto }`.
export interface LoadpointResolveDto {
  // SMART-mode decision only: present (boolean) in smart mode, ABSENT in fast/disabled — where `mode`
  // is the "why" (fast charges unconditionally, disabled never does). Treat absent as "mode decides",
  // NOT as false.
  shouldChargeNow?: boolean;
  budgetA: number; // CIRCUIT budget (bare loadpoint = its own; balancer = the shared pool it splits)
  sources: { energy: string; price: string; current: string };
}

export interface PlanDto {
  id: string;
  loadpointName: string;
  days: DayKey[];
  readyBy: string; // "HH:MM"
  target: number;
  unit: "pct" | "km" | "kwh";
  enabled: boolean;
  vehicles: string[]; // target vehicles (names + 'guest'); [] = any (catch-all)
  pauseOnTarget: boolean; // reaching the target pauses charging (→ Ready); false = planning-only
  resolvedSoc: number | null; // backend display %: pct→value, km→range/soc ratio, kwh/no-car→null
}

export type PlanUnit = PlanDto["unit"];

export interface SettingsDto {
  timezone: string;
}

export interface TariffSlotDto {
  start: string;
  end: string;
  pricePerKWh: number;
  currency: string;
}

// The smart-charging forward schedule for the "price & plan" chart: the next-24h price series, each slot
// flagged `shouldCharge` per the live plan the backend tick computed. Backend-derived
// (GET /api/loadpoints/:name/plan) — the client no longer guesses a cheap window from prices. ISO dates.
export interface LoadpointPlanDto {
  now: string;
  readyBy: string | null; // the active plan's / target's deadline; null when none set (defaulted to 24h)
  window: { from: string; to: string };
  mode: ChargeMode;
  slots: { start: string; end: string; pricePerKWh: number; shouldCharge: boolean }[];
}

export interface BalancerStateDto {
  name: string;
  health: ModuleHealth;
  lastAllocations: Record<string, number> | null;
  freeAmps: number | null;
}

export interface VehicleDataDto {
  soc: number;
  batteryCapacity?: number;
  range?: number;
  isCharging?: boolean;
  targetSoc?: number;
  pluggedIn?: boolean;
  climateActive?: boolean;
  state?: string;
  chargePowerKw?: number;
  remainingChargeMinutes?: number;
  fetchedAt: string;
}

// What a vehicle module can report (self-declared). Drives plan target-units + the auto/manual picker.
export interface VehicleCapabilitiesDto {
  soc: boolean;
  range: boolean;
  capacity: boolean;
  presence: boolean; // reports pluggedIn → auto-identifiable
  climate: boolean;
  targetSoc: boolean;
}

export interface VehicleStateDto {
  name: string;
  health: ModuleHealth;
  data: VehicleDataDto | null;
  capacityKWh: number | null;
  capabilities?: VehicleCapabilitiesDto;
  targetUnits?: PlanUnit[]; // units this vehicle can back (derived from capabilities)
}

export interface MeterStateDto {
  latest: {
    powerW?: number;
    i1A?: number;
    i2A?: number;
    i3A?: number;
    timestamp: string;
  } | null;
  health: ModuleHealth;
}

export interface TransactionDto {
  id: number;
  loadpoint_name: string;
  station_id: string;
  start_time: string;
  end_time: string | null;
  energy_kwh: number | null;
  meter_start: number | null;
  id_tag: string | null;
}

export interface MeterSampleDto {
  measured_at: string;
  energy_kwh: number | null;
  power_w: number | null;
  current_a: number | null;
  soc: number | null;
}

export interface TransactionDetailDto {
  transaction: TransactionDto;
  samples: MeterSampleDto[];
}

export interface SiteLoadpointDto {
  name: string;
  charger: string;
  balancer?: string;
  tariff?: string;
  vehicle?: string;
  maxCurrentA: number;
  targetSoc?: number;
  targetTime?: string;
  targetKWh?: number;
}
export interface SiteChargerDto {
  name: string;
  label?: string; // cosmetic display name (falls back to `name`); rename via PUT /api/chargers/:name
  type: string;
  stationId?: string;
  maxA: number;
}
export interface SiteBalancerDto {
  name: string;
  type: string;
  mainBreakerA: number;
  phases: number;
}
export interface SiteTariffDto {
  name: string;
  type: string;
  zone?: string;
}
export interface SiteVehicleDto {
  name: string;
  type: string;
  vin?: string;
  capabilities?: VehicleCapabilitiesDto;
  targetUnits?: PlanUnit[];
}
export interface SiteMeterDto {
  name: string;
  type: string;
}
export interface SiteDto {
  site: { name: string; port: number; mainBreakerA?: number };
  loadpoints: SiteLoadpointDto[];
  chargers: SiteChargerDto[];
  balancers: SiteBalancerDto[];
  tariffs: SiteTariffDto[];
  vehicles: SiteVehicleDto[];
  meterReaders: SiteMeterDto[];
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// For endpoints that return no body (e.g. 204 DELETE).
async function apiVoid(path: string, init: RequestInit): Promise<void> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
}

export const getLoadpoints = () => apiFetch<LoadpointStateDto[]>("/api/loadpoints");
export const getLoadpoint = (name: string) =>
  apiFetch<LoadpointStateDto>(`/api/loadpoints/${name}`);
export const setMode = (name: string, mode: ChargeMode) =>
  apiFetch<LoadpointStateDto>(`/api/loadpoints/${name}/mode`, json({ mode }));
// /target COALESCE-merges — send only the fields you want to change. `kwh: null` explicitly CLEARS
// the kWh cap (guest "just charge").
export const setTarget = (
  name: string,
  t: { soc?: number; time?: string; kwh?: number | null; minSoc?: number },
) => apiFetch<LoadpointStateDto>(`/api/loadpoints/${name}/target`, json(t));
// Per-session active-vehicle override: null = Guest, or the bound vehicle's name = force the bound car.
export const setLoadpointVehicle = (name: string, vehicle: string | null) =>
  apiFetch<LoadpointStateDto>(`/api/loadpoints/${name}/vehicle`, json({ vehicle }));
export const remoteStart = (name: string) =>
  apiFetch<LoadpointStateDto>(`/api/loadpoints/${name}/start`, { method: "POST" });
export const remoteStop = (name: string) =>
  apiFetch<LoadpointStateDto>(`/api/loadpoints/${name}/stop`, { method: "POST" });
export const resetCharger = (name: string, type: "Soft" | "Hard") =>
  apiFetch<{ ok: boolean; type: string }>(`/api/loadpoints/${name}/reset`, json({ type }));
export const clearProfile = (name: string) =>
  apiFetch<{ status?: string }>(`/api/loadpoints/${name}/clear-profile`, { method: "POST" });
export const getCompositeSchedule = (name: string, duration = 60) =>
  apiFetch<unknown>(`/api/loadpoints/${name}/composite-schedule?duration=${duration}`);
export const setProfile = (name: string, amps: number) =>
  apiFetch<LoadpointStateDto>(`/api/loadpoints/${name}/profile`, json({ amps }));

// Plans. Vehicle-scoped: list ALL globally (the UI filters by charger/active vehicle); create/update/
// delete still route through the plan's loadpoint (its `loadpointName`).
export const getAllPlans = () => apiFetch<PlanDto[]>("/api/plans");
export const createPlan = (
  loadpointName: string,
  body: Omit<PlanDto, "id" | "loadpointName" | "resolvedSoc">,
) => apiFetch<PlanDto>(`/api/loadpoints/${loadpointName}/plans`, jsonBody("POST", body));
export const updatePlanApi = (loadpointName: string, id: string, patch: Partial<PlanDto>) =>
  apiFetch<PlanDto>(`/api/loadpoints/${loadpointName}/plans/${id}`, jsonBody("PUT", patch));
export const deletePlan = (loadpointName: string, id: string) =>
  apiVoid(`/api/loadpoints/${loadpointName}/plans/${id}`, { method: "DELETE" });

// Vehicle management (backend CRUD; creds never echoed). type 'skoda' needs username/password/vin;
// 'manual' needs only a name (no API, kWh-only).
export const addVehicle = (body: {
  name: string;
  type: "skoda" | "manual";
  username?: string;
  password?: string;
  vin?: string;
}) =>
  apiFetch<{ name: string; type: string; vin?: string }>("/api/vehicles", jsonBody("POST", body));
export const deleteVehicle = (name: string) =>
  apiVoid(`/api/vehicles/${name}`, { method: "DELETE" });

// Settings (site timezone)
export const getSettings = () => apiFetch<SettingsDto>("/api/settings");
export const setSettings = (s: SettingsDto) =>
  apiFetch<SettingsDto>("/api/settings", jsonBody("PUT", s));

// Runtime config writes — persist to config_overrides (DB-wins, no restart); each emits config.changed.
export const setSiteBreaker = (mainBreakerA: number) =>
  apiFetch<unknown>("/api/site", jsonBody("PUT", { mainBreakerA }));
export const setTariffZone = (name: string, zone: string) =>
  apiFetch<unknown>(`/api/tariffs/${name}`, jsonBody("PUT", { zone }));
export const updateChargerApi = (name: string, patch: { maxA?: number; label?: string }) =>
  apiFetch<unknown>(`/api/chargers/${name}`, jsonBody("PUT", patch));

export const getHealth = () => apiFetch<Record<string, ModuleHealth>>("/api/health");
export const getSite = () => apiFetch<SiteDto>("/api/site");
// Rolling ~15-min whole-house + car power series for the Home chart (seeds it on load; SSE keeps it live).
export const getPowerHistory = () =>
  apiFetch<{ t: number; total: number; ev: number }[]>("/api/power-history");
export const getTariffPrices = (name: string, from: Date, to: Date) =>
  apiFetch<TariffSlotDto[]>(
    `/api/tariffs/${name}/prices?from=${from.toISOString()}&to=${to.toISOString()}`,
  );
export const getLoadpointPlan = (name: string) =>
  apiFetch<LoadpointPlanDto>(`/api/loadpoints/${name}/plan`);
export const getBalancer = (name: string) => apiFetch<BalancerStateDto>(`/api/balancers/${name}`);
export const getVehicle = (name: string) => apiFetch<VehicleStateDto>(`/api/vehicles/${name}`);
export const getMeter = (name: string) => apiFetch<MeterStateDto>(`/api/meters/${name}`);
export const getTransactions = (opts?: { loadpoint?: string; limit?: number }) => {
  const params = new URLSearchParams();
  if (opts?.loadpoint) params.set("loadpoint", opts.loadpoint);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const qs = params.size > 0 ? `?${params}` : "";
  return apiFetch<TransactionDto[]>(`/api/transactions${qs}`);
};
export const getTransaction = (id: number) =>
  apiFetch<TransactionDetailDto>(`/api/transactions/${id}`);

// Logs (read-only viewer). See docs/ui2-logs-handoff.md for the backend contract.
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry {
  id: number;
  time: string; // ISO
  level: LogLevel;
  module?: string;
  msg: string;
  fields?: Record<string, unknown>; // structured context
  err?: string; // stack / error string when present
}
export const getLogs = (opts?: {
  level?: LogLevel; // minimum severity
  since?: string; // ISO
  until?: string; // ISO
  limit?: number;
  q?: string;
}) => {
  const params = new URLSearchParams();
  if (opts?.level) params.set("level", opts.level);
  if (opts?.since) params.set("since", opts.since);
  if (opts?.until) params.set("until", opts.until);
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.q) params.set("q", opts.q);
  const qs = params.size > 0 ? `?${params}` : "";
  return apiFetch<LogEntry[]>(`/api/logs${qs}`);
};

// Downloadable .log of the full filtered set (no viewer limit) — same filters as getLogs, minus limit.
// Returned as a text/plain attachment by the backend; the UI fetches it and triggers a file download.
export const logsExportUrl = (opts?: {
  level?: LogLevel;
  since?: string;
  until?: string;
  q?: string;
}) => {
  const params = new URLSearchParams();
  if (opts?.level) params.set("level", opts.level);
  if (opts?.since) params.set("since", opts.since);
  if (opts?.until) params.set("until", opts.until);
  if (opts?.q) params.set("q", opts.q);
  const qs = params.size > 0 ? `?${params}` : "";
  return `/api/logs/export${qs}`;
};

// Log retention (days before auto-rotation). Everything is logged; rotation is the only space control.
export interface LogsConfigDto {
  retentionDays: number; // 1–365
}
export const getLogsConfig = () => apiFetch<LogsConfigDto>("/api/logs/config");
export const setLogsConfig = (cfg: LogsConfigDto) =>
  apiFetch<LogsConfigDto>("/api/logs/config", jsonBody("PUT", cfg));
