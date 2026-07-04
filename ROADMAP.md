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
- [x] `docker-compose.yml` updated with OSC service

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

## Milestone 2.5 — MeterReader: Tibber Pulse (TypeScript port) (shipped)

**Goal:** Remove the Python `pulse_bridge.py` sidecar. Read the Tibber Pulse MQTT stream natively in OSC and expose it through a new `MeterReader` SDK module type — so future readers (P1IB, Shelly 3EM, …) are just another swappable module.

- [x] `src/sdk/meter-reader.ts` — new `MeterReader` / `MeterReaderModule` interface + `MeterSnapshot` type
- [x] `registerMeterReader` / `getMeterReaderModule` in `src/sdk/registry-api.ts`
- [x] `src/modules/meter-tibber-pulse/` — direct TypeScript port of `pulse_bridge.py`
  - DSMR/OBIS regex parsers (1-0:1.7.0, 31/51/71.7.0)
  - Periodic `batching_disable true` to keep Pulse un-batched
  - In-process `latest()` + `onSnapshot()` API; no MQTT re-publish by default
- [x] `meterReaders[]` config section; optional `republishPrefix` for MQTT fan-out
- [x] Optional `meterReader: <name>` field on `balancers[]` — in-process path preferred over raw MQTT topics
- [x] `scripts/sim-pulse.mjs` — replays a recorded DSMR frame for testing without real hardware
- [x] `GET /api/meters/:name` REST endpoint — latest snapshot + health
- [x] README updated: native Pulse support, sidecar no longer required

**Verification:**
1. Real Tibber Pulse on LAN → `GET /api/meters/house-pulse` returns fresh `powerW` + `i{1,2,3}A`.
2. Kill the Pulse → health flips to `degraded` after `staleAfterSec`; `latest()` keeps returning last value with `timestamp`.
3. `republishPrefix: house` set → `mosquitto_sub -t 'house/#' -v` shows the same topics `pulse_bridge.py` used to publish.
4. M3 balancer wired to `meterReader: house-pulse` → headroom computed from in-process snapshots.

---

## Milestone 3 — Balancer: MQTT-circuit (shipped)

**Goal:** Dynamic load balancing from live household meter data, with a well-defined degradation path for meter failures.

- [x] `src/modules/balancer-mqtt-circuit/` — in-process MeterReader path (preferred); MQTT topic fallback (`{prefix}/i1_a`, `i2_a`, `i3_a`) when no `meterReader:` is set
- [x] `meterReader: <name>` link path — balancer reads from in-process MeterReader by preference, falls back to `meterTopicPrefix` MQTT subscription when not set (backwards compatible)
- [x] Control loop (default 15 s): `freeAmps = mainBreakerA − max(phaseCurrents) + chargerCurrents`
- [x] Distributes `freeAmps` across active loadpoints — `fast` loadpoints get priority; `smart` get equal split of remaining headroom; `disabled` get 0
- [x] Smart mode: respects tariff windows (no charging in expensive hours); `shouldChargeNow` computed per loadpoint via `planner.plan()` in lifecycle
- [x] Meter staleness: after `meterStaleAfterSec`, switch to `safeStaticCurrentA` per loadpoint; health → `degraded`
- [x] Publishes allocation state to `osc/balancer/<name>/...` (health, free_amps, allocations)
- [x] `GET /api/balancers/:name` REST endpoint — live allocations + health + freeAmps

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

## Milestone 4 — Vehicle: Skoda (shipped)

**Goal:** Read SoC and battery capacity from the MySkoda API; feed the planner for departure-time charging.

- [x] `src/modules/vehicle-skoda/` — VW Group ID OAuth2+PKCE, HTML-form login, token refresh
- [x] Periodic SoC poll (default 15 min, 5 min floor), respects API rate limits
- [x] Cache SoC/capacity/range to SQLite (`vehicle_cache` table); warm on restart
- [x] Refresh token cached to `module_kv` table — no full login on restart
- [x] When API down: return last cached data; health → `degraded`; never throw
- [x] Exposes capacity so `core/estimator.ts` computes estimated SoC from session kWh
- [x] Real SoC-based `requiredKWh` in smart-mode planner (replaces 40%-duty-cycle heuristic)
- [x] `LoadpointSnapshot.estimatedSoc` populated in lifecycle
- [x] `GET /api/vehicles/:name` diagnostics endpoint
- [x] `osc/vehicles/<name>/soc` + `/health` MQTT (retained)
- [x] 3-strike auth lockout (protects MySkoda account from temp-locks)
- [x] Credentials never logged (masked in all debug output)

---

## Milestone 5 — Web UI (shipped)

**Goal:** Full control UI served by the backend (React 19 + Vite).

- [x] `src/ui/` — Vite-bundled React app, served as static files by the backend in production
- [x] Live loadpoint cards (SSE) with mode selector, SoC/time target editor
- [x] Day-ahead price chart per tariff zone (Recharts BarChart, current slot highlighted)
- [x] Balancer allocation view per circuit (freeAmps + per-loadpoint bar chart)
- [x] Transaction history from SQLite with click-to-expand session energy/power chart
- [x] Module health panel with color-coded status; Nav health badge
- [x] Send OCPP commands (RemoteStart/Stop, SetChargingProfile one-shot manual override)
- [x] `npm run dev:all` — single command starts backend + Vite HMR with prefixed logs
- [x] Playwright smoke tests for all 6 pages

---

## Milestone 6 — Polish

- [x] Full module authoring guide (`docs/modules.md`) with worked example
- [x] OSC added to `docker-compose.yml`
- [x] SQLite backup/restore helper script
- [x] Smoke test suite (boot, connect simulated charger, verify REST + MQTT outputs)
- [x] Docs for NTP setup on Pi (clock accuracy matters for tariff slot bucketing)

---

## Out of scope (not planned)

- OCPP 2.0.1 (future parallel module — intentionally not bolted onto 1.6)
- PV / solar surplus charging
- Multi-tenancy or user accounts
- Vehicle brands beyond Skoda / VW group (community modules welcome)
- Embedded MQTT broker
- HEMS / §14a EnWG grid-operator dimming

---

## Known issues / follow-ups (discovered during real-hardware testing, 2026-07-03)

Bugs and doc discrepancies found while first connecting a real charger. None block the OCPP happy path; all are safe to defer, but should be fixed.

### Fixed / added (2026-07-03 real-charger session)

- [x] **Charger stuck at `SuspendedEVSE` / `Current.Offered: 0` — RESOLVED.** Root cause: Zaptec native OCPP **stacks charging profiles (highest stack level wins)** and **persists them across CS reconnects**; a leftover **0 A `TxDefaultProfile` at stack level 8** from evcc's "Off" outranked OSC's hardcoded `stackLevel: 1`. Confirmed with `GetCompositeSchedule` (effective limit `0`); cleared → our profile won → charged. Full write-up + debugging playbook in **`docs/ocpp-smart-charging.md`**. Also fixed en route: **connector `0`→`1`** and **backdated `startSchedule`** in `buildChargingProfilePayload`, and added **`numberPhases: 3`** (see follow-up on making it configurable).
- [x] **Added outbound OCPP commands + REST endpoints:** `Reset` (`/reset`), `ChangeAvailability` (Operative on connect), `ClearChargingProfile` (`/clear-profile`), `GetCompositeSchedule` (`/composite-schedule`) — wired `commands.ts` → `server.ts` → `index.ts` → `src/server/api.ts`.
- [x] **Reconnect-bounce evicted the live station — FIXED.** On a fast reconnect the charger opens a new socket (re-registers in `stations`) before the old socket's `disconnect` fires; the old disconnect then deleted the *current* registration, so messages still flowed (station looked connected) but every command threw "station not connected". `server.ts` disconnect handler now guards `if (s && s.client === client)` before evicting. (This also partially mitigates the connection-state staleness item below.)

### Permanent fix still to land

- [ ] **Install OSC's charging profile at the charger's max stack level** (read `ChargeProfileMaxStackLevel`/`MaxChargingProfilesInstalled` via `GetConfiguration` on connect) with a stable `chargingProfileId`, so ours always wins by replacement — instead of hardcoded `stackLevel: 1`. Do **not** auto-`ClearChargingProfile` on every connect: after a clear the charger reverts to its 32 A default, which during a mid-charge WS reconnect could exceed the circuit breaker. Keep `ClearChargingProfile` manual/diagnostic only.
- [ ] **`numberPhases` is hardcoded `3`** in `buildChargingProfilePayload` (fine for the 3-phase bench; it was *not* the fix). Make it a per-charger `phases` config, or drop it.
- [ ] **On every WebSocket (re)connect, re-assert the profile + refresh status** — flaky-WiFi / laptop-sleep resilience. In `charger-ocpp16/server.ts` `attachClient`: after a socket (re)connects, (a) re-send the loadpoint's current `SetChargingProfile` (at the max stack level, per the item above) so the offered limit is guaranteed correct after any drop or CS takeover, and (b) refresh connection state — push a `connected` status and/or send `TriggerMessage(StatusNotification)` (Zaptec doesn't re-send Boot/Status on a bare WS reconnect). This **supersedes/resolves** the "connection state stale after reconnect" open bug below. **Why it matters (observed):** the charger bounced **17× in the morning** (laptop sleep + WiFi blips, outages up to 35 min); charging survived because the profile persists on the charger, but OSC's view (connected/current/limit) went stale until the next status change. Keep the outbound commands resilient (already `.catch()`ed) so a send that lands mid-bounce fails softly.

### Open bugs / discrepancies

- [ ] **UI/API show `currentA: 0` while the car is charging.** The `MeterValues` handler (`src/modules/charger-ocpp16/server.ts`) pushes only `sessionEnergyKWh` in its `pushStatus`, never `currentA`/`powerW` — so the loadpoint's current never updates even though the real value is parsed and stored in the DB (`meter_values.current_a`). Confirmed live: `/api/loadpoints` `currentA:0` while the DB had `current_a:7.3` and the charger drew ~5.3 kW. **Fix:** include `currentA`/`powerW` (from the parsed MeterValues) in the `pushStatus`, and also push current on the no-active-transaction path so offered/idle current shows.
- [ ] **`sessionEnergyKWh` reports the charger's lifetime meter register, not the session delta.** `latestEnergyKwh` returns the absolute `Energy.Active.Import.Register` (observed ~12,152 kWh). **Fix:** capture `meterStart` on `StartTransaction` and report `latest − meterStart`.

- [ ] **Start/Stop/one-shot-profile endpoints assume loadpoint name == charger name.** `src/server/api.ts` (`/loadpoints/:name/start`, `/stop`, `/profile`) look up the charger via `deps.chargers.get(name)` using the *loadpoint* route param, but the `chargers` map is keyed by **charger name**. If they differ, these commands return `404 loadpoint not found`. **Fix:** resolve the loadpoint's `charger` ref first (`deps.config.loadpoints.find(l => l.name === name)?.charger`), then `deps.chargers.get(chargerName)`. (Mode/target endpoints are correct — they key by loadpoint name.) Workaround today: name the charger and loadpoint identically.

- [ ] **`defaultMode` config field is never honored.** `src/core/loadpoint.ts:37` always seeds new loadpoints with `INSERT ... VALUES (?, 'smart')`, and `loadpointInits` in `src/core/lifecycle.ts:190-197` doesn't pass `defaultMode` through. So a fresh loadpoint always starts in `smart` regardless of config. **Fix:** thread `defaultMode` into `LoadpointInit` and use it in the seed INSERT (first-init only; a persisted mode should still win on restart, which is the current correct behavior).

- [ ] **Price resolution is hourly, but docs claim 15-minute.** `src/modules/tariff-elering/api.ts:45` builds **hourly** slots (`timestamp + 3600`), while `README.md` and `docs/config.md` say "15-minute slot resolution." The planner buckets in 15-min and maps each bucket to its containing hour, so planning granularity is fine — but the price series is hourly. **Fix:** either consume Elering's 15-minute series (Nord Pool moved to 15-min settlement) or correct the docs to say hourly.

- [ ] **`npm run dev:ui` served a blank page — the `/api` dev proxy hijacks the UI's own `src/ui/api/` source modules.** With Vite `root = src/ui`, `src/ui/api/{rest,sse}.ts` are served at `/api/rest.ts` / `/api/sse.ts`, but `server.proxy['/api']` forwards them to the backend → 404 → the module graph fails → white screen. A production build is unaffected (assets are hashed under `/assets/`), which is why the `vite preview`-based e2e tests never caught it. **Workaround applied** in `src/ui/vite.config.ts`: a proxy `bypass` skips requests ending in a JS/TS module extension. **Proper fix:** rename `src/ui/api/` → e.g. `src/ui/client/` (updates ~16 relative imports) so the source path never overlaps the `/api` proxy prefix, then remove the bypass.

- [ ] **Charger connection state & health only refresh on `StatusNotification`, not on WebSocket connect.** `loadpoint.connected` and the `/api/health` map are updated only inside the `charger.onStatus` callback (`src/core/lifecycle.ts` ~209-216), which fires via `pushStatus` on StatusNotification/disconnect. On a *WebSocket reconnect* (vs a power cycle), a charger — confirmed with a Zaptec Go — does **not** re-send BootNotification/StatusNotification, so OSC shows the loadpoint `disconnected` and health `unavailable` even though the socket is live and heartbeating (`charger.health()` computed live from `stations.size` would return `ok`). Real risk for flaky-network chargers: they'd look permanently offline in the UI until the next status change. **Fix:** on `attachClient` (connect) push an initial connected status / refresh the health map, and/or periodically poll live `charger.health()` into the map. → Folded into the **on-(re)connect re-assert + status refresh** item under "Permanent fix still to land" above.
