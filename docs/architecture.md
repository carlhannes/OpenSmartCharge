# Architecture

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│  External control surface                                     │
│  REST API  •  SSE  •  MQTT  •  Web UI                        │
└──────────────┬───────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────┐
│  Core                                                         │
│  Config  •  Registry  •  Plugin loader  •  Event bus          │
│  SQLite  •  Logger  •  Lifecycle                              │
│  Loadpoint  •  Planner  •  Estimator  •  Health              │
└──────────────┬───────────────────────────────────────────────┘
               │  ModuleCtx (sdk-defined handle)
┌──────────────▼───────────────────────────────────────────────┐
│  Modules  (first-party in src/modules/, third-party in plugins/)
│                                                               │
│  Charger    Tariff      Balancer       Vehicle    MeterReader │
│  ocpp16     elering     mqtt-circuit   skoda      tibber-pulse│
└──────────────────────────────────────────────────────────────┘
```

## Data flow (smart mode, healthy)

1. **Config loaded** — the DB config store (schema defaults ⊕ overrides) is read and zod-validated; on a fresh database `osc.yaml` is imported into it once first. Modules are instantiated from the registry.
2. **Loadpoints created** — one per `loadpoints[]` entry, mode restored from SQLite
3. **Tariff module** — fetches day-ahead prices (elprisetjustnu for SE1–SE4, Elering for EE/FI/LV/LT), stores in SQLite; exposes `prices(from, to)`
4. **Control tick** (every `controlIntervalSec`, default 30 s) — one damped loop drives everything. For each smart-mode loadpoint it resolves the governing recurring **plan** (else the ad-hoc target) through a single **target resolver** (`resolveTarget` in `smart-charging/energy.ts` — owns unit conversion incl. `km`→% via the car's range/SoC ratio, the energy degradation ladder, and the display `resolvedSoc`) into `requiredKWh` + `readyBy`, then the price and current ladders, turns that into a 15-min schedule, and commands the charger through a deadband. A **minSoc** floor overrides the price wait and force-charges when the SoC is critically low. Loadpoints sharing a balancer coordinate through `allocate()` (headroom = `mainBreakerA − max(housePhaseCurrents) + sum(chargerCurrents)`); a balancer-less loadpoint is its own circuit and takes the resolved current budget directly. The balancer is a per-tick allocator, not the loop driver — see [AGENTS.md](../AGENTS.md) → "Smart charging" and "Modules vs. the lifecycle".
5. **Vehicle polling** — demand-driven and **lifecycle-owned**: the module exposes `refresh()` (one fetch, no timer); the lifecycle polls it on charger-connect, then every `vehiclePollIntervalSec` (default 15 min) while drawing and the faster `vehicleIdlePollIntervalSec` while plugged-but-idle in the day window — never while unplugged. SoC is cached to SQLite and estimated forward between polls at the efficiency **observed this session** (else the configured constant). SoC/range/capacity are treated as **capabilities**: the vehicle module supplies them today, but the resolver takes plain data, so a charger reporting SoC over the Type-2 wire could feed the same path later — and a loadpoint only offers the target units its data can back (`availableTargetUnits`).
6. **REST / MQTT** — reflect current loadpoint state to consumers
7. **Web UI** — subscribes to SSE, renders live state

## Core modules

### `src/core/config.ts`

The zod schema + the `Config` type. `configSchema.parse({})` is the all-defaults baseline (the effective-config base). `readConfigDocument()` reads `osc.yaml` as a raw import document (no defaults applied); validation happens in `importConfig` / `getEffectiveConfig` against the same schema. `osc.yaml` is **not** the live config — see [Configuration model](#configuration-model).

### `src/core/config-overrides.ts`

The DB config store layered over the defaults base to form the **effective config** (`getEffectiveConfig`), re-validated through the same `configSchema`. Singletons (`site`/`smartCharging`/`mqttBridge`) object-merge; entity kinds are named array elements. `validateConfigWith()` validates a would-be write **before** it is persisted (so a bad value 400s, never bricks boot).

### `src/core/config-io.ts`

Import/export of the config document (a superset of `osc.yaml`): `buildConfigExport` (non-defaults, credentials redacted), `importConfig` (validate-first; `merge`/`replace`; redaction-safe), and `materializeConfigOnce` (first-boot seed of `osc.yaml` into the DB).

### `src/core/reconcile.ts`

The reconcile seam: after an API write persists an override, rebuilds the affected module from the new effective config and mutates the shared `config` object **in place**, so live changes need no restart (durable state is in SQLite; desired state is re-derived each tick).

### `src/core/registry.ts`

A thin factory layer over the SDK registry (`src/sdk/registry-api.ts`). Modules call `registerCharger({ type, create })` at import time; `createCharger(type, cfg, ctx)` and friends look the factory up and throw on an unknown type.

### `src/core/plugin-loader.ts`

Scans `./plugins/*.js` at startup and imports each file. Plugins self-register by calling the SDK registration functions on import. Errors in one plugin are logged but don't crash the system.

### `src/core/events.ts`

A typed `EventEmitter` wrapper. Used for internal pub/sub (e.g., "loadpoint mode changed", "session started"). MQTT publishing is a subscriber to this bus, not the source.

### `src/core/db.ts`

Opens (or creates) `./data/osc.db` via `node:sqlite` (Node.js v22.5+ built-in) and runs the additive migrations on startup. Query helpers live next to the feature that owns the table (`loadpoint.ts`, `plans.ts`, `settings.ts`, `log-store.ts`, the OCPP module's `persistence.ts`, …).

### `src/core/loadpoint.ts`

State machine per configured loadpoint. Holds `mode`, `targetSoc`, `targetTime`, `sessionEnergyKWh`. Mode is read from SQLite on boot and written back on every change.

### `src/core/planner.ts`

Given a set of price slots (hourly or 15-minute) and a required kWh amount, returns a binary on/off schedule for each slot that minimizes cost while finishing by `targetTime`. Falls back to a greedy "start as late as possible" if no price data is available.

### `src/core/estimator.ts`

Computes estimated SoC from `lastKnownSoc + (sessionKWhDelivered × chargingEfficiency / batteryCapacity)`. Accepts `batteryCapacity = undefined` and returns `undefined` in that case (caller handles). The efficiency is **observed within the session** (`observedEfficiency`, from two real readings with enough delta, clamped to a sane band) when available, else the configured constant — so a mid-session vehicle-API dropout keeps estimating SoC accurately and the charge still stops at the right point. Session-scoped only; nothing is learned across sessions.

### `src/core/health.ts`

A passive map of per-module health (`createHealthMap` / `updateHealth` / `getHealthSummary`). The lifecycle refreshes it on module events and in a 15 s sweep and emits `health.changed` on every transition; the API serves it on `GET /api/health` and the MQTT bridge mirrors it to `osc/health/<module>`.

### `src/core/lifecycle.ts`

Entry point. Orchestrates: materialize/load config → open DB → load plugins → instantiate modules → start the HTTP, OCPP and MQTT servers → run the single control loop (one damped tick per `controlIntervalSec`) and the health sweep → register SIGINT/SIGTERM handlers for graceful shutdown.

## Module boundaries

Modules **must not** import from `src/core/` directly. They receive everything they need through `ModuleCtx` (from `src/sdk/`):

```ts
interface ModuleCtx {
  db: DatabaseSync
  events: EventEmitter
  log: Logger
}
```

Modules make HTTP calls with the plain global `fetch` plus a per-request timeout. Jitter, backoff and cadence are scheduling concerns that live where the schedule is decided (the lifecycle; the shared Nord Pool factory for the publish-window refetch), never inside a request primitive.

There is no `ctx.mqtt`: a module that talks MQTT (a meter reader, the outbound bridge) carries its **own** `broker` in its config and opens its own connection — reading a meter and OSC publishing are fully independent.

First-party modules in `src/modules/*` use the same `ModuleCtx` as third-party plugins — same access, same constraints. The only difference is the registration wrapper (see [docs/modules.md](modules.md)).

**Modules are minimal mappers; the lifecycle owns orchestration.** A module translates one external service ⇄ SDK types on demand, actuates when told, and reports its own health — it owns **no** background timers, polling cadence, or cross-module coordination. Deciding _when_ to poll a vehicle, driving the control tick, composing the resolver ladders, and (0.3.0) car↔charger association all live in the lifecycle. This is the codebase's most important boundary; the full statement and worked examples are in [AGENTS.md](../AGENTS.md) → "Modules vs. the lifecycle".

## OCPP connection model

Chargers connect over WebSocket to `ws://<host>:<port>/ocpp`. The `ocpp16` module registers a path handler. Each connecting charger is identified by its `stationId` (the last path segment or the OCPP CP identifier). A single `charger-ocpp16` module instance manages all connected chargers; the loadpoint is matched by the configured `stationId`.

## Persistence

SQLite at `./data/osc.db`. Tables:

- `loadpoint_state` — mode, targetSoc, targetTime, targetKWh, **minSoc** (ad-hoc target + safety floor) per loadpoint name
- `charge_plans` — recurring per-loadpoint plans (days_mask, ready_by, target value+unit, enabled); the resolution layer (`src/core/plans.ts`) in front of the planner
- `config_overrides` — the structural config store: JSON patch per (kind, name) — singletons (`site`/`smartCharging`/`mqttBridge`) + entities (tariffs/balancers/vehicles/chargers/meterReaders/loadpoints). Layered over the defaults base → effective config; `src/core/config-overrides.ts`
- `settings` — system-wide key/value (site `timezone`, `logs.retention_days`, `config.materialized`); `src/core/settings.ts`
- `transactions` — OCPP transaction records
- `meter_values` — raw meter value samples per session
- `tariff_slots` — cached price slots per (zone, slotStart)
- `vehicle_cache` — per-vehicle: `soc`, `battery_capacity_kwh`, `range_km`, `is_charging`, `target_soc`, `plugged_in`, `climate_active`, `fetched_at`
- `household_load_hourly` — hourly MAX of the household phase current per site-local day+hour; feeds the historical current rung (`src/core/smart-charging/rollup.ts`)
- `logs` — the runtime log store behind the Logs viewer (`src/core/log-store.ts`); rotated by age
- `module_kv` — a shared key/value table for small durable module state (e.g. the Škoda refresh token)
- `ocpp_tx_counter` — the OCPP transaction-id sequence

Migrations run automatically on startup (additive only — no destructive migrations).

## Configuration model

The effective config OSC runs on is **`configSchema.parse({})` (defaults) ⊕ the DB config store** (`config_overrides` + `settings` + `loadpoint_state`), re-validated through the same schema. **`osc.yaml` is an import format, not a live base:** on an un-materialized DB (`settings['config.materialized']` unset — a fresh or cleared DB) the lifecycle imports it once (`materializeConfigOnce`), then it is inert. The DB is thereafter the source of truth — edit via the API (which the [config reference](config.md#the-config-model-oscyaml-is-an-import-format) documents as the complete editing surface) or re-import (`POST /api/config/import`, `npm run config:apply`). API writes validate before persisting, reconcile the affected module **in place** (live, except the boot-captured `controlIntervalSec`/`site.port`/`mqttBridge`), and emit `config.changed`. History/cache tables (transactions, meter samples, tariff/vehicle/load caches, the Škoda token, logs) are **data**, never part of config import/export.

**Two timezones (`src/sdk/local-time.ts`, tz always a parameter):** the **site** timezone
(`settings.timezone`, configurable + auto-detected in setup) drives all user-facing planning — the
night window, plan ready-by, targets. Tariff providers use their own **market** timezone (Nord Pool =
`Europe/Stockholm`) for publish windows + per-day price files, which follow the price market regardless
of where the user lives.
