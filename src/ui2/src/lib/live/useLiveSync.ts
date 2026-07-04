import { useEffect } from "react";
import { useOsc, startTick, type Charger, type Vehicle } from "@/lib/mock/store";
import * as api from "@/lib/api/rest";
import { ensureConnected, subscribe } from "@/lib/api/sse";
import {
  mapLoadpoint,
  mapVehicle,
  mapHealth,
  mapPrices,
  mapTransactions,
  deriveStatus,
  currencySymbol,
} from "./map";

const HEALTH_POLL_MS = 15_000;
const next24h = () => {
  const now = new Date();
  return { now, to: new Date(now.getTime() + 24 * 3600000) };
};

/** Apply balancer allocations → per-charger `constraintAmps` (only when actually below max). */
function applyAllocations(alloc: Record<string, number> | null) {
  if (!alloc) return;
  const st = useOsc.getState();
  for (const [name, amps] of Object.entries(alloc)) {
    const c = st.chargers.find((x) => x.id === name);
    if (c) st.patchCharger(name, { constraintAmps: amps < c.maxAmps ? amps : null });
  }
}

/**
 * Backend auto-detect + live sync. Mounted once (client-only) from __root.
 * Success → hydrate the store from REST, subscribe to SSE, poll health, stay "live".
 * Failure (backend unreachable) → fall back to the mock tick ("demo") so parallel dev works.
 * Only the API-backed slices are hydrated; plans/config/pendingChargers keep their local values.
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

      // Topology (optional — used to bind vehicles + pick tariff/balancer).
      let site: api.SiteDto | undefined;
      try {
        site = await api.getSite();
      } catch {
        /* topology optional */
      }
      if (cancelled) return;

      store.hydrate({ chargers: loadpoints.map((lp) => mapLoadpoint(lp, site)) });

      try {
        store.hydrate({ moduleHealth: mapHealth(await api.getHealth()) });
      } catch {
        /* health optional */
      }

      if (site) {
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
        if (!cancelled && vehicles.length) store.hydrate({ vehicles });

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

        for (const b of site.balancers) {
          try {
            const bs = await api.getBalancer(b.name);
            if (!cancelled) applyAllocations(bs.lastAllocations);
          } catch {
            /* balancer optional */
          }
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
            sessionEnergyKWh: number;
          };
          const cur = useOsc.getState().chargers.find((c) => c.id === e.name);
          const mode = cur?.mode ?? "smart";
          useOsc.getState().patchCharger(e.name, {
            status: deriveStatus({ connected: e.connected, charging: e.charging, mode }),
            currentPowerW: Math.round(e.currentA * 230),
            sessionKwh: e.sessionEnergyKWh,
          });
        }),
        subscribe("loadpoint.mode", (d) => {
          const e = d as { name: string; mode: api.ChargeMode };
          const mode: Charger["mode"] = e.mode === "disabled" ? "off" : e.mode;
          const patch: Partial<Charger> = { mode };
          if (mode === "off") patch.status = "off";
          useOsc.getState().patchCharger(e.name, patch);
        }),
        subscribe("loadpoint.target", (d) => {
          const e = d as { name: string; targetKWh?: number };
          useOsc.getState().patchCharger(e.name, { guestTargetKwh: e.targetKWh ?? null });
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
        }),
      );

      // Health has no SSE event → poll.
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
