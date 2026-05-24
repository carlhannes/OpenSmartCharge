# OpenSmartCharge Roadmap

Each milestone is independently shippable — M0 gives you docs and a typed skeleton; M1 gives you a working OCPP server; M2 adds pricing; and so on. You do not need all milestones for a useful system.

## Milestone 0 — Foundation (shipped)

**Goal:** Document the architecture, establish module contracts, wire up the project skeleton so every future milestone drops cleanly into the right slot.

- [x] README, ROADMAP, AGENTS, CONTRIBUTING
- [x] MIT license
- [x] `package.json`, `tsconfig.json`, ESLint, Prettier
- [x] Module SDK interfaces (`src/sdk/`) — `Charger`, `Tariff`, `Balancer`, `Vehicle`
- [x] Core skeleton (`src/core/`) — config loader, module registry, plugin loader, event bus, SQLite, logger, loadpoint, planner, estimator, health, lifecycle
- [x] `osc.dist.yaml` — fully commented example config
- [x] `docker-compose.yml` + `mosquitto.conf` for local broker
- [x] `Dockerfile` stub

**Verification:** `npm install` → `npm run typecheck` → `npm run lint` → `npm run dev` boots and exits cleanly on SIGINT.

---

## Milestone 1 — Charger: OCPP 1.6J + control surface (shipped)

**Goal:** A real OCPP 1.6J server that accepts charger connections, manages loadpoint state, and exposes the full control surface (REST + SSE + MQTT).

- [x] `src/modules/charger-ocpp16/` — WebSocket server using `ocpp-rpc`
- [x] Handlers: BootNotification, Heartbeat, Authorize (stubbed), StatusNotification, MeterValues, StartTransaction, StopTransaction, DataTransfer
- [x] Outbound: RemoteStart/Stop, Reset, SetChargingProfile (TxDefaultProfile/Absolute)
- [x] Transaction + meter value persistence to SQLite
- [x] Loadpoint state machine (`src/core/loadpoint.ts` fully wired) — mode persists across restarts
- [x] REST API (`/api/loadpoints*`, `/api/health`, `/events`)
- [x] MQTT publisher + cmd/* subscriber + Home Assistant MQTT discovery
- [ ] `docker-compose.yml` updated with OSC service

**Verification:**
1. Connect a simulated OCPP charger → appears in REST response and UI.
2. `POST /api/loadpoints/xxx/mode` with `disabled` → charger stops receiving > 0 A.
3. `mosquitto_pub -t osc/loadpoints/xxx/cmd/mode -m fast` → mode change reflected in REST + MQTT state topic.
4. Restart OSC → mode still reflects last value (from SQLite).
5. SSE stream emits event on every mode change.

---

## Milestone 2 — Tariff: Elering (SE1–SE4) (shipped)

**Goal:** Fetch and cache day-ahead prices from the Elering API, expose them to the planner and UI.

- [x] `src/modules/tariff-elering/` — smart daily fetch anchored to 13:15 Stockholm, exponential backoff on failure
- [x] Hourly slot storage in SQLite keyed by `(zone, slot_start)` — survives restart and internet outages
- [x] Health: `ok` → `degraded` (past publish window, no tomorrow data) → `unavailable` (no future slots cached)
- [x] `GET /api/tariffs/:name/prices?from=&to=` endpoint — returns `TariffSlot[]` in EUR/kWh
- [x] `osc/tariffs/<name>/now` MQTT (retained) — re-published on new data and at the top of each hour
- [x] `ctx.fetch` in `ModuleCtx` — drop-in `fetch()` replacement with 0–120 s jitter for thundering-herd prevention

**Verification:**
1. Normal fetch: prices for today appear in `/api/tariffs/home/prices`.
2. Disconnect internet: fetcher retries; module reports `degraded` but returns yesterday's prices.
3. Cold start with no internet and no cache: module reports `unavailable`; planner falls back to flat policy; charger still charges.

---

## Milestone 2.5 — MeterReader: Tibber Pulse (TypeScript port) (next up)

**Goal:** Remove the Python `pulse_bridge.py` sidecar. Read the Tibber Pulse MQTT stream natively in OSC and expose it through a new `MeterReader` SDK module type — so future readers (P1IB, Shelly 3EM, …) are just another swappable module.

- [ ] `src/sdk/meter-reader.ts` — new `MeterReader` / `MeterReaderModule` interface + `MeterSnapshot` type
- [ ] `registerMeterReader` / `getMeterReaderModule` in `src/sdk/registry-api.ts`
- [ ] `src/modules/meter-tibber-pulse/` — direct TypeScript port of `pulse_bridge.py`
  - DSMR/OBIS regex parsers (1-0:1.7.0, 31/51/71.7.0)
  - Periodic `batching_disable true` to keep Pulse un-batched
  - In-process `latest()` + `onSnapshot()` API; no MQTT re-publish by default
- [ ] `meterReaders[]` config section; optional `republishPrefix` for MQTT fan-out
- [ ] Optional `meterReader: <name>` field on `balancers[]` — in-process path preferred over raw MQTT topics
- [ ] `scripts/sim-pulse.mjs` — replays a recorded DSMR frame for testing without real hardware
- [ ] `GET /api/meters/:name` REST endpoint — latest snapshot + health
- [ ] README updated: native Pulse support, sidecar no longer required

**Verification:**
1. Real Tibber Pulse on LAN → `GET /api/meters/house-pulse` returns fresh `powerW` + `i{1,2,3}A`.
2. Kill the Pulse → health flips to `degraded` after `staleAfterSec`; `latest()` keeps returning last value with `timestamp`.
3. `republishPrefix: house` set → `mosquitto_sub -t 'house/#' -v` shows the same topics `pulse_bridge.py` used to publish.
4. M3 balancer wired to `meterReader: house-pulse` → headroom computed from in-process snapshots.

---

## Milestone 3 — Balancer: MQTT-circuit

**Goal:** Dynamic load balancing from live household meter data, with a well-defined degradation path for meter failures.

- [ ] `src/modules/balancer-mqtt-circuit/` — subscribes to `{prefix}/i1_a`, `i2_a`, `i3_a`
- [ ] `meterReader: <name>` link path — balancer reads from in-process MeterReader by preference, falls back to `meterTopicPrefix` MQTT subscription when not set (backwards compatible)
- [ ] Control loop (default 15 s): `freeAmps = mainBreakerA − max(phaseCurrents) + chargerCurrents`
- [ ] Distributes `freeAmps` across active loadpoints respecting modes
- [ ] Smart mode: respects tariff windows (no charging in expensive hours unless needed for departure target)
- [ ] Meter staleness: after `meterStaleAfterSec`, switch to `safeStaticCurrentA` per loadpoint; health → `degraded`
- [ ] Publishes allocation state to `osc/balancer/<name>/...`

**Verification (degradation matrix):**

| Scenario | Expected |
|---|---|
| Full healthy | Dynamic balancing at full optimization |
| Internet down | Balancer uses cached prices; SoC estimated; charging continues |
| Pulse feed stops | `safeStaticCurrentA` applied within `meterStaleAfterSec`; UI shows "meter feed lost" |
| Vehicle API down, never seen | Time-based planning; charging at scheduled start |
| Vehicle API down, seen before | Estimated SoC from capacity + session kWh; departure planning works |
| Everything restored | Auto-recovery, no restart |

---

## Milestone 4 — Vehicle: Skoda

**Goal:** Read SoC and battery capacity from the MySkoda API; feed the planner for departure-time charging.

- [ ] `src/modules/vehicle-skoda/` — MySkoda OAuth, token refresh
- [ ] Periodic SoC poll (default 15 min), respects API rate limits
- [ ] Cache every field (SoC, capacity, VIN) to SQLite with timestamp
- [ ] When API down: return `{ value, ageSec }` — never throw, never return undefined
- [ ] Exposes capacity so `core/estimator.ts` can compute estimated SoC from session kWh

---

## Milestone 5 — Web UI

**Goal:** Full control UI served by the backend (React 19 + Vite).

- [ ] `src/ui/` — Vite-bundled React app, served as static files by the backend in production
- [ ] Live loadpoint cards (SSE) with mode selector
- [ ] Day-ahead price chart per tariff zone
- [ ] Balancer allocation view per circuit
- [ ] Transaction history from SQLite
- [ ] Module health panel
- [ ] Send OCPP commands (RemoteStart/Stop, SetChargingProfile manual override)

---

## Milestone 6 — Polish

- [ ] Full module authoring guide (`docs/modules.md`) with worked example
- [ ] OSC added to `docker-compose.yml`
- [ ] SQLite backup/restore helper script
- [ ] Smoke test suite (boot, connect simulated charger, verify REST + MQTT outputs)
- [ ] Docs for NTP setup on Pi (clock accuracy matters for tariff slot bucketing)

---

## Out of scope (not planned)

- OCPP 2.0.1 (future parallel module — intentionally not bolted onto 1.6)
- PV / solar surplus charging
- Multi-tenancy or user accounts
- Vehicle brands beyond Skoda / VW group (community modules welcome)
- Embedded MQTT broker
- HEMS / §14a EnWG grid-operator dimming
