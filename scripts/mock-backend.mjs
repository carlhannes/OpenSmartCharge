// Quick mock backend for developing/testing ui2 without the real hardware.
// Zero-dependency node:http server implementing the OpenSmartCharge REST + SSE contract
// with mutable in-memory state and a ticking simulation, so ui2 can be driven end-to-end
// including the write path (mode changes, OCPP commands) that can't be tried on a real car.
//
// Point ui2 at it:  OSC_BACKEND=http://localhost:9099 npm run dev:ui2
// Or run both:      npm run dev:ui2:mock
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 9099);

// --- mutable in-memory state ---
const lp = {
  name: "garage",
  mode: "smart", // disabled | smart | fast
  targetSoc: 80,
  targetTime: undefined,
  targetKWh: undefined,
  connected: true,
  charging: true,
  currentA: 10,
  sessionEnergyKWh: 3.2,
  maxCurrentA: 16,
  autoStart: true,
  minSoc: 20,
};
const veh = { soc: 62, range: 310, batteryCapacity: 77 };
let oneShotCap = null;

// Plans (per loadpoint) + site settings.
let plans = [
  {
    id: "1",
    loadpointName: "garage",
    days: ["mon", "tue", "wed", "thu", "fri"],
    readyBy: "07:00",
    target: 80,
    unit: "pct",
    enabled: true,
  },
];
let nextPlanId = 2;
let settings = { timezone: "Europe/Stockholm" };
let siteBreaker = 25; // site-level main breaker (A) — PUT /api/site
let tariffZone = "SE3"; // primary tariff zone — PUT /api/tariffs/:name

const loadpointDto = () => ({
  name: lp.name,
  mode: lp.mode,
  ...(lp.targetSoc != null ? { targetSoc: lp.targetSoc } : {}),
  ...(lp.targetTime != null ? { targetTime: lp.targetTime } : {}),
  ...(lp.targetKWh != null ? { targetKWh: lp.targetKWh } : {}),
  ...(lp.minSoc != null ? { minSoc: lp.minSoc } : {}),
  connected: lp.connected,
  charging: lp.charging,
  currentA: lp.charging ? lp.currentA : 0,
  sessionEnergyKWh: +lp.sessionEnergyKWh.toFixed(2),
  maxCurrentA: lp.maxCurrentA,
  autoStart: lp.autoStart,
  availableTargetUnits: [
    ...(veh.soc != null && veh.batteryCapacity != null ? ["pct"] : []),
    ...(veh.range != null ? ["km"] : []),
    "kwh",
  ],
});

// Backend computes each plan's display SoC%: pct→value, km→via range/soc ratio, kwh/no-car→null.
const resolvedSocFor = (p) => {
  if (p.unit === "pct") return p.target;
  if (p.unit === "km") {
    if (!veh.soc || !veh.range) return null;
    const fullRangeKm = veh.range / (veh.soc / 100);
    return Math.min(100, Math.round((p.target / fullRangeKm) * 100));
  }
  return null; // kwh
};
const planDto = (p) => ({ ...p, resolvedSoc: resolvedSocFor(p) });

const txRow = (id) => ({
  id,
  loadpoint_name: "garage",
  station_id: "MOCK-1",
  start_time: new Date(Date.now() - id * 86400000 - 3600000).toISOString(),
  end_time: new Date(Date.now() - id * 86400000).toISOString(),
  energy_kwh: 8 + id * 3,
  meter_start: 0,
  id_tag: null,
});

// --- SSE fan-out ---
const clients = new Set();
const emit = (event, data) => {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
};
const stateFrame = () =>
  emit("loadpoint.state", {
    name: lp.name,
    connected: lp.connected,
    charging: lp.charging,
    currentA: lp.charging ? lp.currentA : 0,
    sessionEnergyKWh: +lp.sessionEnergyKWh.toFixed(2),
  });

// Ticking simulation: advance the session while charging and push live SSE.
setInterval(() => {
  if (lp.connected && lp.charging && lp.mode !== "disabled") {
    const cap = oneShotCap ?? lp.maxCurrentA;
    lp.currentA = lp.mode === "fast" ? lp.maxCurrentA : Math.min(cap, lp.maxCurrentA);
    lp.sessionEnergyKWh += ((lp.currentA * 230) / 1000) * (2 / 3600); // ~2s of energy
    veh.soc = Math.min(100, veh.soc + 0.2);
    veh.range = Math.round(veh.batteryCapacity * (veh.soc / 100) * 6.5);
  } else {
    lp.currentA = 0;
  }
  stateFrame();
  emit("vehicle.poll", { name: "enyaq", soc: Math.round(veh.soc) });
}, 2000);
setInterval(() => {
  for (const res of clients) res.write(": heartbeat\n\n");
}, 30000);

const send = (res, obj, code = 200) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(obj));
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }

  const p = new URL(req.url, "http://x").pathname;

  if (p === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  // Settings (site timezone).
  if (p === "/api/settings") {
    if (req.method === "GET") return send(res, settings);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const b = JSON.parse(body || "{}");
        if (b.timezone) settings = { timezone: b.timezone };
      } catch {
        /* ignore */
      }
      emit("settings.changed", settings);
      return send(res, settings);
    });
    return;
  }

  // Runtime config writes — each mutates state + emits config.changed (ui2 reconciles from /api/site).
  const readBody = (cb) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        cb(JSON.parse(body || "{}"));
      } catch {
        cb({});
      }
    });
  };
  if (p === "/api/site" && req.method === "PUT") {
    readBody((b) => {
      if (b.mainBreakerA != null) siteBreaker = b.mainBreakerA;
      emit("config.changed", { kind: "site", name: "site" });
      send(res, { ok: true });
    });
    return;
  }
  const tariffPut = p.match(/^\/api\/tariffs\/([^/]+)$/);
  if (tariffPut && req.method === "PUT") {
    readBody((b) => {
      if (b.zone) tariffZone = b.zone;
      emit("config.changed", { kind: "tariff", name: tariffPut[1] });
      send(res, { ok: true });
    });
    return;
  }
  const chargerPut = p.match(/^\/api\/chargers\/([^/]+)$/);
  if (chargerPut && req.method === "PUT") {
    readBody((b) => {
      if (b.maxA != null) lp.maxCurrentA = b.maxA;
      emit("config.changed", { kind: "charger", name: chargerPut[1] });
      send(res, { ok: true });
    });
    return;
  }

  // Plans: /api/loadpoints/:name/plans[/:id]
  const planMatch = p.match(/^\/api\/loadpoints\/([^/]+)\/plans(?:\/([^/]+))?$/);
  if (planMatch) {
    const name = planMatch[1];
    const id = planMatch[2];
    if (req.method === "GET")
      return send(res, plans.filter((pl) => pl.loadpointName === name).map(planDto));
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let b = {};
      try {
        b = body ? JSON.parse(body) : {};
      } catch {
        /* ignore */
      }
      if (req.method === "POST") {
        const plan = {
          id: String(nextPlanId++),
          loadpointName: name,
          days: b.days,
          readyBy: b.readyBy,
          target: b.target,
          unit: b.unit,
          enabled: b.enabled ?? true,
        };
        plans.push(plan);
        emit("loadpoint.plans", { name });
        return send(res, planDto(plan), 201);
      }
      if (req.method === "PUT" && id) {
        const plan = plans.find((pl) => pl.id === id && pl.loadpointName === name);
        if (!plan) {
          res.writeHead(404, { "access-control-allow-origin": "*" });
          return res.end("not found");
        }
        Object.assign(plan, b);
        emit("loadpoint.plans", { name });
        return send(res, planDto(plan));
      }
      if (req.method === "DELETE" && id) {
        plans = plans.filter((pl) => !(pl.id === id && pl.loadpointName === name));
        emit("loadpoint.plans", { name });
        res.writeHead(204, { "access-control-allow-origin": "*" });
        return res.end();
      }
      res.writeHead(405, { "access-control-allow-origin": "*" });
      res.end("method not allowed");
    });
    return;
  }

  // Writes: mutate state, then push the matching SSE event.
  if (req.method === "POST" && p.startsWith("/api/loadpoints/")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let b = {};
      try {
        b = body ? JSON.parse(body) : {};
      } catch {
        /* ignore */
      }
      if (p.endsWith("/mode")) {
        lp.mode = b.mode;
        if (lp.mode === "disabled") lp.charging = false;
        emit("loadpoint.mode", { name: lp.name, mode: lp.mode });
        return send(res, loadpointDto());
      }
      if (p.endsWith("/target")) {
        // COALESCE-merge — only overwrite fields present in the body.
        if (b.soc !== undefined) lp.targetSoc = b.soc;
        if (b.time !== undefined) lp.targetTime = b.time;
        if (b.kwh !== undefined) lp.targetKWh = b.kwh;
        if (b.minSoc !== undefined) lp.minSoc = b.minSoc;
        emit("loadpoint.target", {
          name: lp.name,
          targetSoc: lp.targetSoc,
          targetTime: lp.targetTime,
          targetKWh: lp.targetKWh,
          minSoc: lp.minSoc,
        });
        return send(res, loadpointDto());
      }
      if (p.endsWith("/start")) {
        lp.charging = true;
        stateFrame();
        return send(res, loadpointDto());
      }
      if (p.endsWith("/stop")) {
        lp.charging = false;
        lp.currentA = 0;
        stateFrame();
        return send(res, loadpointDto());
      }
      if (p.endsWith("/reset")) return send(res, { ok: true, type: b.type === "Hard" ? "Hard" : "Soft" });
      if (p.endsWith("/clear-profile")) {
        oneShotCap = null;
        return send(res, { status: "Accepted" });
      }
      if (p.endsWith("/profile")) {
        oneShotCap = b.amps;
        return send(res, loadpointDto());
      }
      return send(res, loadpointDto());
    });
    return;
  }

  if (p.startsWith("/api/loadpoints/") && p.endsWith("/composite-schedule"))
    return send(res, {
      connectorId: 1,
      chargingSchedule: {
        duration: 3600,
        chargingRateUnit: "A",
        chargingSchedulePeriod: [
          { startPeriod: 0, limit: oneShotCap ?? lp.maxCurrentA },
          { startPeriod: 1800, limit: 6 },
        ],
      },
    });

  if (p === "/api/loadpoints") return send(res, [loadpointDto()]);
  if (p === "/api/loadpoints/garage") return send(res, loadpointDto());
  if (p === "/api/health")
    return send(res, {
      garage: "ok",
      tariff: "ok",
      "balancer:house": "degraded",
      "vehicle:enyaq": "ok",
      mqtt: "ok",
    });
  if (p === "/api/site")
    return send(res, {
      site: { name: "Mock Home", port: PORT, mainBreakerA: siteBreaker, timezone: settings.timezone },
      loadpoints: [
        { name: "garage", charger: "garage", tariff: "home", balancer: "house", vehicle: "enyaq", maxCurrentA: lp.maxCurrentA, autoStart: true },
      ],
      chargers: [{ name: "garage", type: "ocpp16", stationId: "MOCK-1", maxA: lp.maxCurrentA }],
      balancers: [{ name: "house", type: "mqtt-circuit", mainBreakerA: siteBreaker, phases: 3 }],
      tariffs: [{ name: "home", type: "nordpool", zone: tariffZone }],
      vehicles: [{ name: "enyaq", type: "skoda", vin: "MOCKVIN" }],
      meterReaders: [{ name: "pulse", type: "tibber-pulse" }],
    });
  if (p === "/api/vehicles/enyaq")
    return send(res, {
      name: "enyaq",
      health: "ok",
      data: {
        soc: Math.round(veh.soc),
        range: veh.range,
        batteryCapacity: veh.batteryCapacity,
        isCharging: lp.charging,
        pluggedIn: lp.connected,
        fetchedAt: new Date().toISOString(),
      },
      capacityKWh: veh.batteryCapacity,
    });
  if (p.startsWith("/api/tariffs/") && p.endsWith("/prices"))
    return send(
      res,
      Array.from({ length: 24 }, (_, h) => ({
        start: new Date(new Date().setHours(h, 0, 0, 0)).toISOString(),
        end: new Date(new Date().setHours(h + 1, 0, 0, 0)).toISOString(),
        pricePerKWh: +(0.6 + 0.5 * Math.sin(h / 3.5)).toFixed(3),
        currency: "SEK",
      })),
    );
  if (p === "/api/balancers/house")
    return send(res, { name: "house", health: "ok", lastAllocations: { garage: lp.currentA }, freeAmps: 13 });
  if (p === "/api/transactions") return send(res, [txRow(1), txRow(2)]);
  if (p.startsWith("/api/transactions/"))
    return send(res, {
      transaction: txRow(Number(p.split("/").pop()) || 1),
      samples: Array.from({ length: 20 }, (_, i) => ({
        measured_at: new Date(Date.now() - 3600000 + i * 180000).toISOString(),
        energy_kwh: +(i * 0.6).toFixed(2),
        power_w: 7000 + i * 60,
        current_a: 30,
        soc: 40 + i * 2,
      })),
    });

  res.writeHead(404, { "access-control-allow-origin": "*" });
  res.end("not found");
});

server.listen(PORT, () => console.log(`[mock-backend] OpenSmartCharge mock on http://localhost:${PORT}`));
