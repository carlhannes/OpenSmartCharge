import { useEffect } from "react";
import { useOsc, startTick, type Charger, type Vehicle } from "@/lib/mock/store";
import * as api from "@/lib/api/rest";
import { ensureConnected, subscribe } from "@/lib/api/sse";
import {
  mapLoadpoint,
  mapPlan,
  mapVehicle,
  mapHealth,
  mapMeterWatts,
  mapPrices,
  mapLoadpointPlan,
  mapTransactions,
  deriveStatus,
  currencySymbol,
} from "./map";

const HEALTH_POLL_MS = 15_000;
const next24h = () => {
  const now = new Date();
  return { now, to: new Date(now.getTime() + 24 * 3600000) };
};

/** Refetch one loadpoint's price+plan chart data (backend-derived). */
async function refetchLoadpointPlan(name: string) {
  try {
    useOsc.getState().setLoadpointPlan(name, mapLoadpointPlan(await api.getLoadpointPlan(name)));
  } catch {
    /* plan optional */
  }
}
function refetchAllLoadpointPlans() {
  for (const c of useOsc.getState().chargers) void refetchLoadpointPlan(c.id);
}

/** Apply balancer allocations → per-charger `constraintAmps` (only when actually below max). */
function applyAllocations(alloc: Record<string, number> | null) {
  if (!alloc) return;
  const st = useOsc.getState();
  for (const [name, amps] of Object.entries(alloc)) {
    const c = st.chargers.find((x) => x.id === name);
    if (c) st.patchCharger(name, { constraintAmps: amps < c.maxAmps ? amps : null });
  }
}

/** Re-fetch ALL plans (plans are vehicle-scoped/global) and replace the store's set. */
async function refetchAllPlans() {
  try {
    useOsc.getState().hydrate({ plans: (await api.getAllPlans()).map(mapPlan) });
  } catch {
    /* ignore */
  }
}

/**
 * Re-hydrate everything derived from GET /api/site (+ loadpoints): chargers and the site config
 * (region / breaker / tariffName). Called on startup and on every `config.changed` SSE, so runtime
 * config writes reconcile to the backend's truth. Returns the fetched site so startup can reuse it
 * for the downstream vehicle/price/balancer blocks (no double-fetch).
 */
async function rehydrateSite(
  loadpoints?: api.LoadpointStateDto[],
): Promise<api.SiteDto | undefined> {
  let lps = loadpoints;
  if (!lps) {
    try {
      lps = await api.getLoadpoints();
    } catch {
      return undefined;
    }
  }
  let site: api.SiteDto | undefined;
  try {
    site = await api.getSite();
  } catch {
    /* topology optional */
  }
  useOsc.getState().hydrate({ chargers: lps.map((lp) => mapLoadpoint(lp, site)) });
  if (site) {
    const zone = site.tariffs[0]?.zone;
    const tariffName = site.tariffs[0]?.name;
    const siteBreaker = site.site.mainBreakerA ?? site.balancers[0]?.mainBreakerA;
    const sitePhases = site.balancers[0]?.phases; // only a balancer exposes phases; else default 3
    useOsc.getState().setConfig({
      ...(zone ? { region: zone } : {}),
      ...(tariffName ? { tariffName } : {}),
      ...(siteBreaker != null ? { breakerAmps: siteBreaker } : {}),
      ...(sitePhases != null ? { phases: sitePhases } : {}),
      // No dynamic balancer configured → the main breaker is a static safe limit.
      ...(site.balancers.length === 0 && siteBreaker != null
        ? { balancerMode: "static" as const, staticLimitA: siteBreaker }
        : {}),
    });
    useOsc.getState().setMeterName(site.meterReaders[0]?.name ?? null);
    // Vehicles (name + capabilities + live reading) — mapped here so add/remove (config.changed)
    // reflects without a reload. getVehicle tolerates a manual car (data: null) → mapVehicle degrades.
    const vehicles = (
      await Promise.all(
        site.vehicles.map((v) =>
          api
            .getVehicle(v.name)
            .then((dto) => mapVehicle(v.name, dto))
            .catch(() => null),
        ),
      )
    ).filter((v): v is Vehicle => v != null);
    useOsc.getState().hydrate({ vehicles });
  }
  return site;
}

/**
 * Backend auto-detect + live sync. Mounted once (client-only) from __root.
 * Success → hydrate the store from REST, subscribe to SSE, poll health, stay "live".
 * Failure (backend unreachable) → fall back to the mock tick ("demo") so parallel dev works.
 * Site-derived slices (chargers + region/breaker config) reconcile via rehydrateSite on `config.changed`.
 */
export function useLiveSync() {
  useEffect(() => {
    let cancelled = false;
    const unsubs: Array<() => void> = [];
    let healthTimer: ReturnType<typeof setInterval> | null = null;

    void (async () => {
      const store = useOsc.getState();

      // Probe. Any failure → demo mode.
      let loadpoints: api.LoadpointStateDto[];
      try {
        loadpoints = await api.getLoadpoints();
      } catch {
        if (!cancelled) {
          store.setSource("demo");
          startTick();
        }
        return;
      }
      if (cancelled) return;
      store.setSource("live");

      // Chargers + site config (region/breaker/tariffName) via the shared reconcile fn — reused on
      // every `config.changed` SSE. Returns the fetched site so we reuse it below (no double-fetch).
      const site = await rehydrateSite(loadpoints);
      if (cancelled) return;

      // All plans (vehicle-scoped/global). Vehicles were mapped by rehydrateSite above.
      try {
        if (!cancelled) store.hydrate({ plans: (await api.getAllPlans()).map(mapPlan) });
      } catch {
        /* plans optional */
      }
      try {
        const settings = await api.getSettings();
        if (!cancelled) store.setTimezone(settings.timezone);
      } catch {
        /* settings optional */
      }

      try {
        store.hydrate({ moduleHealth: mapHealth(await api.getHealth()) });
      } catch {
        /* health optional */
      }

      if (site) {
        const tariff = site.tariffs[0];
        if (tariff) {
          const { now, to } = next24h();
          try {
            const slots = await api.getTariffPrices(tariff.name, now, to);
            if (!cancelled) {
              store.hydrate({ prices: mapPrices(slots) });
              store.setConfig({ currencySymbol: currencySymbol(slots[0]?.currency) });
            }
          } catch {
            /* prices optional */
          }
        }

        // Per-loadpoint charge plan (price series + schedule) for the charger "price & plan" chart.
        for (const lp of site.loadpoints) {
          try {
            const p = await api.getLoadpointPlan(lp.name);
            if (!cancelled) store.setLoadpointPlan(lp.name, mapLoadpointPlan(p));
          } catch {
            /* plan optional */
          }
        }

        for (const b of site.balancers) {
          try {
            const bs = await api.getBalancer(b.name);
            if (!cancelled) applyAllocations(bs.lastAllocations);
          } catch {
            /* balancer optional */
          }
        }

        // Live household power — initial value; the meter.snapshot SSE keeps it fresh.
        const meterName = site.meterReaders[0]?.name;
        if (meterName) {
          try {
            const m = await api.getMeter(meterName);
            if (!cancelled) store.setHousePower(mapMeterWatts(m.latest));
          } catch {
            if (!cancelled) store.setHousePower(null);
          }
        } else if (!cancelled) {
          store.setHousePower(null);
        }
      }

      try {
        const txs = await api.getTransactions({ limit: 50 });
        if (!cancelled) store.hydrate({ sessions: mapTransactions(txs) });
      } catch {
        /* history optional */
      }

      if (cancelled) return;

      // Live updates.
      ensureConnected();
      unsubs.push(
        subscribe("loadpoint.state", (d) => {
          const e = d as {
            name: string;
            connected: boolean;
            charging: boolean;
            currentA: number;
            powerW: number;
            sessionEnergyKWh: number;
            sessionComplete?: boolean;
            deliveredKWh?: number;
          };
          const cur = useOsc.getState().chargers.find((c) => c.id === e.name);
          const mode = cur?.mode ?? "smart";
          const finished = e.sessionComplete ?? false;
          useOsc.getState().patchCharger(e.name, {
            status: deriveStatus({
              connected: e.connected,
              charging: e.charging,
              drawing: (e.currentA ?? 0) > 0.5,
              mode,
              finished,
            }),
            finished,
            connected: e.connected,
            charging: e.charging,
            drawingA: e.currentA ?? 0,
            currentPowerW: e.powerW ?? Math.round(e.currentA * 230), // backend 3-phase power, not single-phase
            sessionKwh: e.deliveredKWh ?? e.sessionEnergyKWh,
          });
        }),
        subscribe("loadpoint.mode", (d) => {
          const e = d as { name: string; mode: api.ChargeMode };
          const mode: Charger["mode"] = e.mode === "disabled" ? "off" : e.mode;
          const cur = useOsc.getState().chargers.find((c) => c.id === e.name);
          const patch: Partial<Charger> = { mode };
          // Recompute status from the current raw inputs so a mode change doesn't clobber "ready"
          // (a completed session stays Ready); fall back to "off" only before we have the charger.
          if (cur)
            patch.status = deriveStatus({
              connected: cur.connected,
              charging: cur.charging,
              drawing: cur.drawingA > 0.5,
              mode,
              finished: cur.finished,
            });
          else if (mode === "off") patch.status = "off";
          useOsc.getState().patchCharger(e.name, patch);
          void refetchLoadpointPlan(e.name); // mode change reshapes the plan (smart vs fast/off)
        }),
        subscribe("loadpoint.target", (d) => {
          const e = d as { name: string; targetKWh?: number; minSoc?: number };
          useOsc.getState().patchCharger(e.name, {
            guestTargetKwh: e.targetKWh ?? null,
            minSoc: e.minSoc ?? null,
          });
          void refetchLoadpointPlan(e.name); // target/deadline change reshapes the plan
        }),
        subscribe("loadpoint.activeVehicle", (d) => {
          const e = d as { name: string; activeVehicle: string | null };
          useOsc.getState().patchCharger(e.name, { activeVehicleId: e.activeVehicle });
          void refetchLoadpointPlan(e.name); // a different car → different target/plan
        }),
        subscribe("loadpoint.session", (d) => {
          const e = d as { name: string; complete: boolean; deliveredKWh: number };
          const cur = useOsc.getState().chargers.find((c) => c.id === e.name);
          // Tick-derived: the session-complete flag + the peak-hold delivered total. Recompute status
          // from the stored raw inputs (this event carries only the finished flag), so "Ready" surfaces
          // even when meter frames stop once the car idles at 0 A.
          useOsc.getState().patchCharger(e.name, {
            finished: e.complete,
            sessionKwh: e.deliveredKWh,
            ...(cur
              ? {
                  status: deriveStatus({
                    connected: cur.connected,
                    charging: cur.charging,
                    drawing: cur.drawingA > 0.5,
                    mode: cur.mode,
                    finished: e.complete,
                  }),
                }
              : {}),
          });
        }),
        subscribe("vehicle.poll", (d) => {
          const e = d as { name: string; soc: number };
          useOsc.getState().patchVehicle(e.name, { soc: e.soc });
        }),
        subscribe("balancer.tick", (d) => {
          const e = d as { name: string; allocations: Record<string, number>; freeAmps: number };
          applyAllocations(e.allocations);
        }),
        subscribe("tariff.updated", (d) => {
          const e = d as { name: string };
          const { now, to } = next24h();
          api
            .getTariffPrices(e.name, now, to)
            .then((slots) => useOsc.getState().hydrate({ prices: mapPrices(slots) }))
            .catch(() => {});
          refetchAllLoadpointPlans(); // prices changed → every loadpoint's plan reshapes
        }),
        subscribe("loadpoint.plans", () => {
          void refetchAllPlans();
          refetchAllLoadpointPlans(); // plan definitions changed → schedules reshape
        }),
        subscribe("settings.changed", (d) => {
          const e = d as { timezone: string };
          useOsc.getState().setTimezone(e.timezone);
        }),
        subscribe("config.changed", () => {
          // Any runtime config write (region/breaker/charger/…) → reconcile from GET /api/site.
          void rehydrateSite();
        }),
        subscribe("meter.snapshot", (d) => {
          const e = d as {
            name: string;
            snapshot: { powerW?: number; i1A?: number; i2A?: number; i3A?: number };
          };
          if (e.name === useOsc.getState().meterName) {
            useOsc.getState().setHousePower(mapMeterWatts(e.snapshot));
          }
        }),
        // Health is live: the backend emits `health.changed` on any module transition (+ a periodic
        // sweep), forwarded over SSE — so a charger dropping / a source going stale reflects within
        // ~1 s instead of up to a poll interval. Patches the single module the event names.
        subscribe("health.changed", (d) => {
          const e = d as { id: string; health: api.ModuleHealth };
          useOsc.getState().patchHealth(e.id, e.health);
        }),
      );

      // Backstop poll: SSE `health.changed` (above) keeps health live; this reconciles the full set
      // periodically too, covering the initial snapshot + any event missed across a reconnect.
      healthTimer = setInterval(() => {
        api
          .getHealth()
          .then((h) => useOsc.getState().hydrate({ moduleHealth: mapHealth(h) }))
          .catch(() => {});
      }, HEALTH_POLL_MS);
    })();

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
      if (healthTimer) clearInterval(healthTimer);
    };
  }, []);
}
