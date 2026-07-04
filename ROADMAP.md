# OpenSmartCharge Roadmap

Each milestone is independently shippable — M0 gives you docs and a typed skeleton; M1 gives you a working OCPP server; M2 adds pricing; and so on. You do not need all milestones for a useful system.

> **Next up:** the [v0.2.0 UX vision & backend roadmap](docs/vision-0.2.0.md) — a mobile-first redesign (onboarding, recurring plans, km/% targets) and the backend work (config-as-data, charger pairing) it requires.

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

## Milestone 2 — Tariff: Nord Pool day-ahead (shipped)

**Goal:** Fetch and cache day-ahead prices, expose them to the planner and UI.

- [x] `src/modules/tariff-elering/` — **Baltics + Finland (EE/FI/LV/LT)**. Smart daily fetch anchored to 13:15 Stockholm, exponential backoff on failure
- [x] `src/modules/tariff-elprisetjustnu/` — **Sweden (SE1–SE4)**, 15-minute resolution, SEK/kWh, no API key. (Elering does *not* publish Swedish zones.) Both providers share the Nord Pool schedule/persistence/health factory in `src/sdk/nordpool-tariff.ts`
- [x] Slot storage in SQLite keyed by `(zone, slot_start)` (hourly or 15-min) — survives restart and internet outages
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

Bugs and doc discrepancies found bringing up a real charger. The set below was worked through and **resolved** in the 2026-07-03 → 07-04 hardening pass (test-first); a few nice-to-haves remain.

### Resolved (real-charger hardening, 2026-07-03 → 07-04)

- [x] **Charger stuck at `SuspendedEVSE` / `Current.Offered: 0`.** Root cause: Zaptec native OCPP **stacks charging profiles (highest stack level wins)** and **persists them across CS reconnects**; a leftover **0 A `TxDefaultProfile` at stack level 8** from evcc's "Off" outranked OSC's `stackLevel: 1`. Full write-up + debugging playbook in **`docs/ocpp-smart-charging.md`**.
- [x] **Permanent stack-level fix:** OSC reads `ChargeProfileMaxStackLevel` via `GetConfiguration` on connect and installs its `TxDefaultProfile` at that top level (`stackLevel` threaded through `buildChargingProfilePayload`/`setCurrentLimit`/`setLimit`), so it always outranks leftover/default profiles — no auto-clear needed. Connector `0`→`1` + backdated `startSchedule` also applied.
- [x] **`numberPhases` is now a per-charger `phases` config** (default 3), threaded through the profile builder.
- [x] **Reconnect resilience (flaky-WiFi / host-sleep):** on every (re)connect OSC re-asserts the last commanded limit + `TriggerMessage(StatusNotification)`; status subscriptions persist across reconnects so the loadpoint keeps updating after a drop. Resolves the old "connection state stale after reconnect" bug.
- [x] **Reconnect-bounce eviction:** disconnect handler guards `s.client === client` so a stale disconnect can't evict a live re-registered socket.
- [x] **Live current/power:** `MeterValues` push `currentA`/`powerW` to `ChargerStatus` → `/api/loadpoints.currentA` (was stuck at 0 while charging). Also **cleared to 0 when not charging** — a bare `StatusNotification`/`StopTransaction` carries no `currentA`, so the last live reading was sticking after a stop (UI showed e.g. `9.7 A` with the car idle); `foldChargerStatus` (`loadpoint.ts`) forces 0 whenever `charging` is false.
- [x] **Session energy = delta:** report `(latest register − meterStart)`; added `transactions.meter_start` + guarded additive migration.
- [x] **Outbound OCPP commands + REST endpoints:** `Reset`, `ChangeAvailability`, `ClearChargingProfile`, `GetCompositeSchedule`, `GetConfiguration`, `TriggerMessage`.
- [x] **Endpoint loadpoint→charger resolution:** `/start`,`/stop`,`/profile`,`/reset`,`/clear-profile`,`/composite-schedule` resolve the loadpoint's charger (no longer assume loadpoint name == charger name).
- [x] **`defaultMode` honored** when seeding a new loadpoint (persisted mode still wins on restart).
- [x] **Docs:** README/`docs/architecture.md` corrected "15-minute" tariff resolution → hourly (Elering/Nord Pool day-ahead).
- [x] **UI dev-server blank page:** renamed `src/ui/api/` → `src/ui/client/` so it no longer collides with the `/api` dev proxy; removed the `vite.config.ts` `bypass`.
- [x] Raw OCPP frame logging is now opt-in via `OCPP_TRACE=1`.

Covered by tests: `src/modules/charger-ocpp16/server.integration.test.ts` (mock charger — 5 scenarios), `src/server/api.test.ts`, `src/core/loadpoint.test.ts`.

### Smart charging: graceful degradation (shipped 2026-07-04)

Smart mode now works with **any subset of dependencies degraded**, via pure resolver ladders (`src/core/smart-charging/`) driven by a single control loop — no combinatorial `if (X degraded)` branching. Each input resolver returns `{value, source, degraded}`; consumers read only `.value`.

- [x] **Swedish prices** via `tariff-elprisetjustnu` (SE1–SE4, 15-min, SEK); shared Nord Pool factory + `sdk/stockholm-time.ts` (DST-safe local time).
- [x] **Energy / price / current resolver ladders** — SoC→fixed-kWh→duty-cycle; live→3-day-avg→static-night; live-meter→worst-case→time-of-day-static. Unit-tested incl. the ASAP-price trap and the 6 A floor.
- [x] **Control-loop inversion** (`control-loop.ts`): one damped 30 s tick (configurable, deadband-gated) drives every circuit; **smart mode works with no balancer** (the old no-balancer path applied max, price-blind). Balancer circuits still coordinate through the untouched, test-pinned `allocate()`.
- [x] **New config:** `site.mainBreakerA`, a `smartCharging` block (interval/deadband/night-window/margins/historicalDays), loadpoint `targetKWh` (surfaced in API/MQTT/UI); config `targetSoc`/`targetTime`/`targetKWh` now seed the DB.
- [x] **Household-load hourly rollup** (`smart-charging/rollup.ts`) feeds the worst-case-current fallback; `parseTargetTime` + night-window are now Stockholm-local (were server-local).
- [x] Verified live on the real Zaptec (no balancer, no vehicle): resolved `{energy: duty-cycle, price: live-tariff, current: static-tod}`, gated on the SE4 price.

### Resolved (correctness pass, 2026-07-04)

- [x] **Smart mode ignored price when a control tick landed off a 15-min boundary.** `decideShouldCharge` found no planned slot covering "now" (plan slots start at the *next* boundary) and defaulted to charge — so smart mode charged ~14 of every 15 minutes regardless of price. Now falls back to the imminent slot's decision. (`f77674e`)
- [x] **Live current/energy zeroed on OSC restart or a bare charger WS reconnect.** `activeTransactionId` was in-memory only; now rehydrated from the open transaction on connect (`findOpenTransaction`) + MeterValues trust the charger's own `transactionId`. Also repairs `remoteStop` after a reconnect.
- [x] **Setting one target NULLed the others.** `POST /target {soc}` wiped `targetTime`/`targetKWh`; `setLoadpointTarget` + `handleTargetChange` now merge (undefined = leave unchanged).
- [x] **Declarative `config:apply` CLI.** `npm run config:apply` overwrites persisted loadpoint mode/targets from `osc.yaml` (the DB remains the runtime source of truth; boot still persist-wins). See `docs/config.md`.
- [x] **Latent hardening:** transactions insert with the OCPP id as PK directly (no fragile insert-then-UPDATE remap); `parseMeterValue` honours `sampledValue.unit` (kWh vs Wh); `/api/transactions/:id` per-sample energy is the session delta, not the lifetime register.

### Remaining / nice-to-have

- [ ] Exclude `*.test.ts` + `mock-charger.ts` from the production build (they currently compile into `dist/` — harmless dead weight). Add to `tsconfig.json`/build config.
- [ ] Unify the typed test **mock charger** (`src/modules/charger-ocpp16/mock-charger.ts`) with the `.mjs` sim (`scripts/lib/fake-charger.mjs`) to remove transport duplication.
- [ ] `powerW` is on `ChargerStatus` but not surfaced on `LoadpointState`/UI — add a field + bridge if a power readout is wanted.
- [ ] Surface each loadpoint's resolver `sources` (energy/price/current rung) on `/api/loadpoints/:name` for UI observability (currently debug-logged only).
