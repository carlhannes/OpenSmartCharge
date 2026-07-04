import { create } from "zustand";
import type { ChargerRuntimeStatus } from "@/lib/copy";
import { generatePrices } from "./prices";
import type { DayKey } from "@/lib/format";

export type Mode = "off" | "smart" | "fast";

export interface Vehicle {
  id: string;
  name: string; // "Enyaq"
  brand: string; // "Škoda"
  soc: number; // %
  rangeKm: number;
  batteryKwh: number;
  connected: boolean;
  climateOn?: boolean;
}

export interface Plan {
  id: string;
  chargerId: string;
  days: DayKey[];
  readyBy: string; // "07:00"
  target: number;
  unit: "pct" | "km" | "kwh";
  enabled: boolean;
}

export interface Charger {
  id: string;
  name: string;
  maxAmps: number;
  mode: Mode;
  status: ChargerRuntimeStatus;
  activeVehicleId: string | null; // null = Guest
  currentPowerW: number;
  sessionKwh: number;
  sessionStart: number | null; // ms
  guestTargetKwh: number | null;
  constraintAmps: number | null; // when limited by balancer
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
  balancerMode: "tibber" | "mqtt" | "static";
  staticLimitA: number;
  houseUsageKw: number;
  currencySymbol: string;
}

interface OscState {
  chargers: Charger[];
  vehicles: Vehicle[];
  plans: Plan[];
  sessions: Session[];
  moduleHealth: ModuleHealth[];
  prices: number[];
  pendingChargers: PendingCharger[];
  config: Config;
  tickMs: number;
  source: "probing" | "live" | "demo"; // probing→ decide; live = backend via REST/SSE; demo = mock tick

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
  removeVehicle: (id: string) => void;
  restoreVehicle: (vehicle: Vehicle, activeOnChargerIds: string[]) => void;

  claimPending: (pendingId: string, name: string, maxAmps: number) => void;
  emitPending: () => void;

  setConfig: (patch: Partial<Config>) => void;
  finishOnboarding: () => void;
  resetAll: () => void;
  importSnapshot: (json: string) => boolean;

  oneShotAmps: (chargerId: string, amps: number | null) => void;

  // Live-sync (populated from the backend when source === "live")
  setSource: (source: "probing" | "live" | "demo") => void;
  hydrate: (
    patch: Partial<
      Pick<OscState, "chargers" | "vehicles" | "moduleHealth" | "prices" | "sessions">
    >,
  ) => void;
  patchCharger: (id: string, patch: Partial<Charger>) => void;
  patchVehicle: (id: string, patch: Partial<Vehicle>) => void;

  _tick: () => void;
}

const uid = () => Math.random().toString(36).slice(2, 10);

function seed(): Pick<
  OscState,
  | "chargers"
  | "vehicles"
  | "plans"
  | "sessions"
  | "moduleHealth"
  | "prices"
  | "pendingChargers"
  | "config"
  | "tickMs"
> {
  const now = Date.now();
  const vehicle: Vehicle = {
    id: "v_enyaq",
    name: "Enyaq",
    brand: "Škoda",
    soc: 62,
    rangeKm: 310,
    batteryKwh: 77,
    connected: true,
  };
  const charger: Charger = {
    id: "c_garage",
    name: "Garage",
    maxAmps: 16,
    mode: "smart",
    status: "waiting_cheap",
    activeVehicleId: vehicle.id,
    currentPowerW: 0,
    sessionKwh: 0,
    sessionStart: null,
    guestTargetKwh: null,
    constraintAmps: null,
  };
  const plan: Plan = {
    id: "p_default",
    chargerId: charger.id,
    days: ["mon", "tue", "wed", "thu", "fri"],
    readyBy: "07:00",
    target: 80,
    unit: "pct",
    enabled: true,
  };

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
    prices: generatePrices(1),
    pendingChargers: [],
    config: {
      isConfigured: true,
      onboardingStep: 0,
      region: "SE3",
      breakerAmps: 25,
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
  source: "probing",

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
      activeVehicleId: null,
      currentPowerW: 0,
      sessionKwh: 0,
      sessionStart: null,
      guestTargetKwh: null,
      constraintAmps: null,
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
  hydrate: (patch) => set(patch),
  patchCharger: (id, patch) =>
    set((s) => ({ chargers: s.chargers.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  patchVehicle: (id, patch) =>
    set((s) => ({ vehicles: s.vehicles.map((v) => (v.id === id ? { ...v, ...patch } : v)) })),

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

    set({ chargers: nextChargers, vehicles: nextVehicles });
  },
}));

let started = false;
export function startTick() {
  if (started || typeof window === "undefined") return;
  started = true;
  setInterval(() => useOsc.getState()._tick(), useOsc.getState().tickMs);
}
