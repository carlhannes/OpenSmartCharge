import { create } from "zustand";
import type { ChargerRuntimeStatus } from "@/lib/copy";
import { generatePrices } from "./prices";
import type { MappedLoadpointPlan } from "@/lib/live/map";
import type { VehicleTypeDto } from "@/lib/api/rest";
import type { DayKey } from "@/lib/format";

export type Mode = "off" | "smart" | "fast";

// Demo mirror of the backend's GET /api/vehicle-types (which the demo can't fetch — no backend). Live
// mode replaces this via setVehicleTypes on startup. Kept in step with the skoda/manual descriptors in
// src/modules/vehicle-*/index.ts — same shape the real endpoint returns, so <VehicleForm> is identical.
export const DEMO_VEHICLE_TYPES: VehicleTypeDto[] = [
  {
    type: "skoda",
    label: "Škoda / VW group (app login)",
    fields: [
      { key: "username", label: "App email", required: true },
      { key: "password", label: "App password", type: "password", required: true, secret: true },
      {
        key: "vin",
        label: "VIN",
        required: true,
        pattern: "^[A-Za-z0-9]{17}$",
        help: "17 characters, as shown in the MySkoda app.",
      },
    ],
    capabilities: {
      soc: true,
      range: true,
      capacity: true,
      presence: true,
      climate: true,
      targetSoc: true,
    },
  },
  {
    type: "manual",
    label: "Manual (no app / other car)",
    fields: [],
    capabilities: {
      soc: false,
      range: false,
      capacity: false,
      presence: false,
      climate: false,
      targetSoc: false,
    },
  },
];

export interface Vehicle {
  id: string;
  name: string; // "Enyaq"
  brand: string; // "Škoda"
  // Backend vehicle-module type ('skoda' | 'manual' | …) — picks the right edit form + capabilities.
  type: string;
  // VIN for skoda-style types — the one non-secret field the backend exposes, so the edit form can
  // pre-fill it (creds like username/password are write-only). Absent for manual.
  vin?: string;
  soc: number; // %
  rangeKm: number;
  batteryKwh: number;
  connected: boolean;
  climateOn?: boolean;
  // Units this car can target (backend capabilities): app car → pct/km/kwh; manual/API-less → kwh only.
  targetUnits: ("pct" | "km" | "kwh")[];
  // Has SoC/range telemetry (an app car) vs a manual/API-less car — gates the SoC display + auto-detect.
  hasTelemetry: boolean;
}

export interface Plan {
  id: string;
  chargerId: string;
  days: DayKey[];
  readyBy: string; // "07:00"
  target: number;
  unit: "pct" | "km" | "kwh";
  enabled: boolean;
  vehicles: string[]; // target vehicles (names + 'guest'); [] = any (catch-all)
  pauseOnTarget: boolean; // reaching the target pauses charging (→ Ready); false = planning-only
  resolvedSoc: number | null; // backend display %: pct→value, km→ratio, kwh/no-car→null
}

export interface Charger {
  id: string;
  name: string;
  maxAmps: number;
  mode: Mode;
  status: ChargerRuntimeStatus;
  finished: boolean; // backend-resolved session-complete → the "ready" status (live only)
  // Raw status inputs kept so `status` recomputes from either SSE event (live only); demo sets status directly.
  connected: boolean;
  charging: boolean;
  drawingA: number;
  activeVehicleId: string | null; // resolved active vehicle from the backend; null = Guest
  // Sticky manual pick (for the charger picker highlight): undefined/null = Auto, 'guest', or a vehicle id.
  vehicleOverride?: string | null;
  boundVehicleId?: string | null; // the loadpoint's configured vehicle binding (live only; static)
  currentPowerW: number;
  sessionKwh: number;
  sessionStart: number | null; // ms
  guestTargetKwh: number | null;
  minSoc: number | null; // keep-above floor (%), from POST /target { minSoc }
  constraintAmps: number | null; // when limited by balancer
  availableTargetUnits: Plan["unit"][]; // units the plan editor may offer (from the backend)
}

export interface Session {
  id: string;
  chargerId: string;
  vehicleName: string;
  startedAt: number;
  endedAt: number;
  kwh: number;
  costEur: number;
  socStart?: number;
  socEnd?: number;
}

export interface ModuleHealth {
  id: string;
  name: string;
  status: "ok" | "warn" | "bad";
  message: string;
}

export interface PendingCharger {
  id: string;
  stationId: string;
  connectedAt: number;
}

export interface Config {
  isConfigured: boolean;
  onboardingStep: number;
  region: string;
  breakerAmps: number;
  phases: number; // supply phases — sets the max-kW axis on the Home power chart; default 3
  balancerMode: "tibber" | "mqtt" | "static";
  staticLimitA: number;
  houseUsageKw: number;
  currencySymbol: string;
  tariffName?: string; // primary tariff name — target for region writes (PUT /api/tariffs/:name)
}

interface OscState {
  chargers: Charger[];
  vehicles: Vehicle[];
  /** Selectable vehicle types + their self-described forms (demo seed; live = GET /api/vehicle-types).
   *  Drives the shared <VehicleForm> for create/edit/onboarding. */
  vehicleTypes: VehicleTypeDto[];
  plans: Plan[];
  sessions: Session[];
  moduleHealth: ModuleHealth[];
  prices: number[];
  /** Per-charger "price & plan" chart data (keyed by charger id): backend-derived in live mode
   *  (GET /api/loadpoints/:name/plan), synthesized in demo. */
  loadpointPlans: Record<string, MappedLoadpointPlan>;
  pendingChargers: PendingCharger[];
  config: Config;
  tickMs: number;
  source: "probing" | "live" | "demo"; // probing→ decide; live = backend via REST/SSE; demo = mock tick
  timezone: string; // site timezone (IANA); from GET /api/settings when live
  housePowerW: number | null; // live whole-house draw (W) from the meter; null = no live reading
  /** Rolling ~15-min history of whole-house + car power for the Home stacked-bar chart. Appended on
   *  every meter reading (live) / tick (demo); samples older than 15 min are dropped. */
  powerHistory: PowerSample[];
  meterName: string | null; // main meter reader name (from /api/site) — matches meter.snapshot
  _houseBaseW: number; // demo-only: wandering non-EV base for the mock house-power sim

  // actions
  setMode: (chargerId: string, mode: Mode) => void;
  setActiveVehicle: (chargerId: string, vehicleId: string | null) => void;
  setGuestTarget: (chargerId: string, kwh: number | null) => void;
  renameCharger: (id: string, name: string) => void;
  setChargerMaxAmps: (id: string, amps: number) => void;
  removeCharger: (id: string) => void;
  restoreCharger: (charger: Charger, plans: Plan[]) => void;

  addPlan: (chargerId: string) => Plan;
  updatePlan: (id: string, patch: Partial<Plan>) => void;
  removePlan: (id: string) => void;

  addVehicle: (v: Omit<Vehicle, "id">) => Vehicle;
  updateVehicle: (id: string, patch: Partial<Omit<Vehicle, "id">>) => void;
  removeVehicle: (id: string) => void;
  restoreVehicle: (vehicle: Vehicle, activeOnChargerIds: string[]) => void;
  /** Replace the selectable vehicle types (live: fetched on startup). */
  setVehicleTypes: (types: VehicleTypeDto[]) => void;

  claimPending: (pendingId: string, name: string, maxAmps: number) => void;
  emitPending: () => void;

  setConfig: (patch: Partial<Config>) => void;
  finishOnboarding: () => void;
  resetAll: () => void;
  importSnapshot: (json: string) => boolean;

  oneShotAmps: (chargerId: string, amps: number | null) => void;

  // Live-sync (populated from the backend when source === "live")
  setSource: (source: "probing" | "live" | "demo") => void;
  setTimezone: (tz: string) => void;
  setHousePower: (w: number | null) => void;
  /** Replace the power-history buffer (seeded from GET /api/power-history on load). */
  setPowerHistory: (samples: PowerSample[]) => void;
  setMeterName: (n: string | null) => void;
  hydrate: (
    patch: Partial<
      Pick<OscState, "chargers" | "vehicles" | "moduleHealth" | "prices" | "sessions" | "plans">
    >,
  ) => void;
  patchCharger: (id: string, patch: Partial<Charger>) => void;
  patchVehicle: (id: string, patch: Partial<Vehicle>) => void;
  /** Replace a charger's chart plan (from GET .../plan when live, or the demo synthesizer). */
  setLoadpointPlan: (chargerId: string, plan: MappedLoadpointPlan) => void;
  /** Patch a single module's health from a `health.changed` SSE event (id + backend status),
   *  remapping to the store's status vocabulary. Inserts the entry if it's new. */
  patchHealth: (id: string, health: "ok" | "degraded" | "unavailable") => void;

  _tick: () => void;
}

export interface PowerSample {
  t: number; // epoch ms
  total: number; // whole-house draw (W)
  ev: number; // car charging (W) — a subset of total
}

const POWER_HISTORY_MS = 15 * 60_000;
const POWER_MIN_INTERVAL_MS = 10_000; // match the server buffer's ~10s cadence — skip sub-10s appends

// Append a power sample (throttled to ~10s + pruned to the 15-min window). Pure — returns a new array,
// or the SAME array when throttled (so the chart's memo doesn't churn between the ~10s samples).
function appendPowerSample(
  prev: PowerSample[],
  total: number,
  ev: number,
  now: number,
): PowerSample[] {
  const last = prev[prev.length - 1];
  if (last && now - last.t < POWER_MIN_INTERVAL_MS) return prev;
  const cutoff = now - POWER_HISTORY_MS;
  return [...prev.filter((s) => s.t >= cutoff), { t: now, total, ev }];
}

const uid = () => Math.random().toString(36).slice(2, 10);

// Demo-only: synthesize a backend-style plan for the mock chart — the cheapest hours BEFORE the ready-by,
// on a true rolling next-24h window. Live mode replaces this via GET /api/loadpoints/:name/plan.
function demoLoadpointPlan(prices: number[], readyByHour: number): MappedLoadpointPlan {
  const now = new Date();
  const nowH = now.getHours();
  const hourMs = 3_600_000;
  const fromMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), nowH).getTime();
  const toMs = fromMs + 24 * hourMs;
  const readyByMs = fromMs + ((readyByHour - nowH + 24) % 24 || 24) * hourMs;
  const slots = Array.from({ length: 24 }, (_, i) => {
    const startMs = fromMs + i * hourMs;
    return {
      startMs,
      endMs: startMs + hourMs,
      price: prices[(nowH + i) % 24] ?? 0.15,
      charge: false,
    };
  });
  // cheapest ~40% of the pre-deadline slots → charge (deadline-aware, unlike the old client guess)
  const eligible = slots
    .filter((s) => s.startMs < readyByMs)
    .map((s) => s.price)
    .sort((a, b) => a - b);
  const threshold = eligible[Math.floor(eligible.length * 0.4)] ?? Infinity;
  for (const s of slots) if (s.startMs < readyByMs && s.price <= threshold) s.charge = true;
  return { readyByMs, fromMs, toMs, slots };
}

function seed(): Pick<
  OscState,
  | "chargers"
  | "vehicles"
  | "plans"
  | "sessions"
  | "moduleHealth"
  | "prices"
  | "loadpointPlans"
  | "pendingChargers"
  | "config"
  | "tickMs"
> {
  const now = Date.now();
  const vehicle: Vehicle = {
    id: "v_enyaq",
    name: "Enyaq",
    brand: "Škoda",
    type: "skoda",
    vin: "TMBJJ7NX5N0000001",
    soc: 62,
    rangeKm: 310,
    batteryKwh: 77,
    connected: true,
    targetUnits: ["pct", "km", "kwh"],
    hasTelemetry: true,
  };
  const charger: Charger = {
    id: "c_garage",
    name: "Garage",
    maxAmps: 16,
    mode: "smart",
    status: "waiting_cheap",
    finished: false,
    connected: true,
    charging: false,
    drawingA: 0,
    activeVehicleId: vehicle.id,
    currentPowerW: 0,
    sessionKwh: 0,
    sessionStart: null,
    guestTargetKwh: null,
    minSoc: null,
    constraintAmps: null,
    availableTargetUnits: ["pct", "km", "kwh"],
  };
  const plan: Plan = {
    id: "p_default",
    chargerId: charger.id,
    days: ["mon", "tue", "wed", "thu", "fri"],
    readyBy: "07:00",
    target: 80,
    unit: "pct",
    enabled: true,
    vehicles: ["v_enyaq"],
    pauseOnTarget: true,
    resolvedSoc: 80, // pct passthrough; demo-only (live replaces plans from the backend)
  };

  const demoPrices = generatePrices(1);
  const sessions: Session[] = [];
  for (let i = 1; i <= 7; i++) {
    const kwh = 8 + Math.random() * 22;
    sessions.push({
      id: uid(),
      chargerId: charger.id,
      vehicleName: vehicle.name,
      startedAt: now - i * 86400000 - 6 * 3600000,
      endedAt: now - i * 86400000 - 2 * 3600000,
      kwh,
      costEur: kwh * (0.09 + Math.random() * 0.08),
      socStart: 30 + Math.floor(Math.random() * 20),
      socEnd: 70 + Math.floor(Math.random() * 20),
    });
  }

  return {
    chargers: [charger],
    vehicles: [vehicle],
    plans: [plan],
    sessions,
    moduleHealth: [
      { id: "ocpp", name: "Charger link (OCPP)", status: "ok", message: "1 charger online." },
      { id: "tariff", name: "Day-ahead prices", status: "ok", message: "Elering · SE3 · fresh." },
      { id: "balancer", name: "House load balancer", status: "ok", message: "Tibber Pulse live." },
      { id: "vehicle", name: "Vehicle data", status: "ok", message: "Škoda Enyaq linked." },
      { id: "mqtt", name: "MQTT / Home Assistant", status: "ok", message: "Broker connected." },
    ],
    prices: demoPrices,
    loadpointPlans: {
      [charger.id]: demoLoadpointPlan(demoPrices, parseInt(plan.readyBy.split(":")[0], 10)),
    },
    pendingChargers: [],
    config: {
      isConfigured: true,
      onboardingStep: 0,
      region: "SE3",
      breakerAmps: 25,
      phases: 3,
      balancerMode: "tibber",
      staticLimitA: 16,
      houseUsageKw: 1.8,
      currencySymbol: "€",
    },
    tickMs: 1500,
  };
}

export const useOsc = create<OscState>()((set, get) => ({
  ...seed(),
  vehicleTypes: DEMO_VEHICLE_TYPES,
  source: "probing",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  housePowerW: null, // set by the meter (live) or the demo tick; card hides until a real value arrives
  powerHistory: [],
  meterName: null,
  _houseBaseW: 700,

  setMode: (chargerId, mode) =>
    set((s) => ({
      chargers: s.chargers.map((c) =>
        c.id === chargerId ? { ...c, mode, status: mode === "off" ? "off" : c.status } : c,
      ),
    })),

  setActiveVehicle: (chargerId, vehicleId) =>
    set((s) => ({
      chargers: s.chargers.map((c) =>
        c.id === chargerId ? { ...c, activeVehicleId: vehicleId } : c,
      ),
    })),

  setGuestTarget: (chargerId, kwh) =>
    set((s) => ({
      chargers: s.chargers.map((c) => (c.id === chargerId ? { ...c, guestTargetKwh: kwh } : c)),
    })),

  renameCharger: (id, name) =>
    set((s) => ({ chargers: s.chargers.map((c) => (c.id === id ? { ...c, name } : c)) })),

  setChargerMaxAmps: (id, amps) =>
    set((s) => ({ chargers: s.chargers.map((c) => (c.id === id ? { ...c, maxAmps: amps } : c)) })),

  removeCharger: (id) =>
    set((s) => ({
      chargers: s.chargers.filter((c) => c.id !== id),
      plans: s.plans.filter((p) => p.chargerId !== id),
    })),

  restoreCharger: (charger, plans) =>
    set((s) => ({
      chargers: [...s.chargers, charger],
      plans: [...s.plans, ...plans],
    })),

  addPlan: (chargerId) => {
    const plan: Plan = {
      id: uid(),
      chargerId,
      days: ["mon", "tue", "wed", "thu", "fri"],
      readyBy: "07:00",
      target: 80,
      unit: "pct",
      enabled: true,
      vehicles: [],
      pauseOnTarget: true,
      resolvedSoc: null, // backend fills this via the loadpoint.plans SSE re-fetch
    };
    set((s) => ({ plans: [...s.plans, plan] }));
    return plan;
  },

  updatePlan: (id, patch) =>
    set((s) => ({ plans: s.plans.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),

  removePlan: (id) => set((s) => ({ plans: s.plans.filter((p) => p.id !== id) })),

  addVehicle: (v) => {
    const nv = { ...v, id: uid() };
    set((s) => ({ vehicles: [...s.vehicles, nv] }));
    return nv;
  },

  updateVehicle: (id, patch) =>
    set((s) => ({ vehicles: s.vehicles.map((v) => (v.id === id ? { ...v, ...patch } : v)) })),

  setVehicleTypes: (types) => set({ vehicleTypes: types }),

  removeVehicle: (id) =>
    set((s) => ({
      vehicles: s.vehicles.filter((v) => v.id !== id),
      chargers: s.chargers.map((c) =>
        c.activeVehicleId === id ? { ...c, activeVehicleId: null } : c,
      ),
    })),

  restoreVehicle: (vehicle, activeOnChargerIds) =>
    set((s) => ({
      vehicles: [...s.vehicles, vehicle],
      chargers: s.chargers.map((c) =>
        activeOnChargerIds.includes(c.id) ? { ...c, activeVehicleId: vehicle.id } : c,
      ),
    })),

  claimPending: (pendingId, name, maxAmps) => {
    const p = get().pendingChargers.find((x) => x.id === pendingId);
    if (!p) return;
    const charger: Charger = {
      id: uid(),
      name,
      maxAmps,
      mode: "smart",
      status: "unplugged",
      finished: false,
      connected: false,
      charging: false,
      drawingA: 0,
      activeVehicleId: null,
      currentPowerW: 0,
      sessionKwh: 0,
      sessionStart: null,
      guestTargetKwh: null,
      minSoc: null,
      constraintAmps: null,
      availableTargetUnits: ["pct", "km", "kwh"],
    };
    set((s) => ({
      chargers: [...s.chargers, charger],
      pendingChargers: s.pendingChargers.filter((x) => x.id !== pendingId),
    }));
  },

  emitPending: () =>
    set((s) => ({
      pendingChargers: [
        ...s.pendingChargers,
        {
          id: uid(),
          stationId: `SN-${Math.floor(1000 + Math.random() * 9000)}A`,
          connectedAt: Date.now(),
        },
      ],
    })),

  setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),
  finishOnboarding: () =>
    set((s) => ({ config: { ...s.config, isConfigured: true, onboardingStep: 0 } })),

  resetAll: () => {
    set(seed());
  },

  importSnapshot: (json) => {
    try {
      const parsed = JSON.parse(json);
      set(parsed);
      return true;
    } catch {
      return false;
    }
  },

  oneShotAmps: (chargerId, amps) =>
    set((s) => ({
      chargers: s.chargers.map((c) => (c.id === chargerId ? { ...c, constraintAmps: amps } : c)),
    })),

  setSource: (source) => set({ source }),
  setTimezone: (tz) => set({ timezone: tz }),
  setHousePower: (w) =>
    set((s) => ({
      housePowerW: w,
      powerHistory:
        w == null
          ? s.powerHistory
          : appendPowerSample(
              s.powerHistory,
              w,
              s.chargers.reduce((a, c) => a + (c.currentPowerW > 0 ? c.currentPowerW : 0), 0),
              Date.now(),
            ),
    })),
  setPowerHistory: (samples) => set({ powerHistory: samples }),
  setMeterName: (n) => set({ meterName: n }),
  hydrate: (patch) => set(patch),
  patchCharger: (id, patch) =>
    set((s) => ({ chargers: s.chargers.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  setLoadpointPlan: (chargerId, plan) =>
    set((s) => ({ loadpointPlans: { ...s.loadpointPlans, [chargerId]: plan } })),
  patchVehicle: (id, patch) =>
    set((s) => ({ vehicles: s.vehicles.map((v) => (v.id === id ? { ...v, ...patch } : v)) })),
  patchHealth: (id, health) =>
    set((s) => {
      const status = health === "ok" ? "ok" : health === "degraded" ? "warn" : "bad";
      const exists = s.moduleHealth.some((m) => m.id === id);
      return {
        moduleHealth: exists
          ? s.moduleHealth.map((m) => (m.id === id ? { ...m, status } : m))
          : [...s.moduleHealth, { id, name: id, status, message: "" }],
      };
    }),

  _tick: () => {
    if (get().source !== "demo") return; // mock tick runs only in confirmed demo mode
    const s = get();
    const nextChargers = s.chargers.map((c) => {
      const veh = s.vehicles.find((v) => v.id === c.activeVehicleId) ?? null;
      const hour = new Date().getHours();
      const currentPrice = s.prices[hour] ?? 0.15;
      const cheap =
        currentPrice <= s.prices.slice().sort((a, b) => a - b)[Math.floor(s.prices.length * 0.35)];

      let status: ChargerRuntimeStatus = c.status;
      let power = c.currentPowerW;

      if (c.mode === "off") {
        status = "off";
        power = 0;
      } else if (!veh && c.guestTargetKwh == null && !c.activeVehicleId) {
        status = "unplugged";
        power = 0;
      } else if (veh && veh.soc >= 99) {
        status = "ready";
        power = 0;
      } else if (c.mode === "fast") {
        status = "fast_charging";
        power = c.maxAmps * 230 * 0.98;
      } else if (c.mode === "smart") {
        if (cheap) {
          status = "charging";
          const limit = c.constraintAmps ?? c.maxAmps;
          power = Math.min(limit, c.maxAmps) * 230 * 0.95;
        } else {
          status = "waiting_cheap";
          power = 0;
        }
      }
      return { ...c, status, currentPowerW: power };
    });

    const nextVehicles = s.vehicles.map((v) => {
      const linked = nextChargers.find((c) => c.activeVehicleId === v.id);
      if (!linked || linked.currentPowerW <= 0) return v;
      const kWhPerTick = (linked.currentPowerW / 1000) * (s.tickMs / 3600000);
      const socDelta = (kWhPerTick / v.batteryKwh) * 100;
      const newSoc = Math.min(100, v.soc + socDelta * 6); // exaggerate for demo feel
      return {
        ...v,
        soc: newSoc,
        rangeKm: Math.round(v.batteryKwh * (newSoc / 100) * 6.5),
      };
    });

    // Demo house power: a wandering non-EV base + whatever the car is drawing.
    const evW = nextChargers.reduce((a, c) => a + (c.currentPowerW > 0 ? c.currentPowerW : 0), 0);
    const houseBase = Math.round(
      Math.min(1800, Math.max(250, s._houseBaseW + (Math.random() - 0.5) * 350)),
    );
    const total = houseBase + Math.round(evW);
    set({
      chargers: nextChargers,
      vehicles: nextVehicles,
      _houseBaseW: houseBase,
      housePowerW: total,
      powerHistory: appendPowerSample(s.powerHistory, total, Math.round(evW), Date.now()),
    });
  },
}));

let started = false;
export function startTick() {
  if (started || typeof window === "undefined") return;
  started = true;
  setInterval(() => useOsc.getState()._tick(), useOsc.getState().tickMs);
}
