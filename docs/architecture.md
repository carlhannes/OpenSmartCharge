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

1. **Config loaded** — YAML parsed, zod-validated, modules instantiated from registry
2. **Loadpoints created** — one per `loadpoints[]` entry, mode restored from SQLite
3. **Tariff module** — fetches day-ahead prices (elprisetjustnu for SE1–SE4, Elering for EE/FI/LV/LT), stores in SQLite; exposes `prices(from, to)`
4. **Control tick** (every `controlIntervalSec`, default 30 s) — one damped loop drives everything. For each smart-mode loadpoint it resolves the governing recurring **plan** (else the ad-hoc target) through a single **target resolver** (`resolveTarget` in `smart-charging/energy.ts` — owns unit conversion incl. `km`→% via the car's range/SoC ratio, the energy degradation ladder, and the display `resolvedSoc`) into `requiredKWh` + `readyBy`, then the price and current ladders, turns that into a 15-min schedule, and commands the charger through a deadband. A **minSoc** floor overrides the price wait and force-charges when the SoC is critically low. Loadpoints sharing a balancer coordinate through `allocate()` (headroom = `mainBreakerA − max(housePhaseCurrents) + sum(chargerCurrents)`); a balancer-less loadpoint is its own circuit and takes the resolved current budget directly. The balancer is a per-tick allocator, not the loop driver — see [AGENTS.md](../AGENTS.md) → "Smart charging" and "Modules vs. the lifecycle".
5. **Vehicle polling** — demand-driven and **lifecycle-owned**: the module exposes `refresh()` (one fetch, no timer); the lifecycle polls it on charger-connect and, while charging, at most every `vehiclePollIntervalSec` (default 30 min) — never while idle. SoC is cached to SQLite and estimated forward between polls at the efficiency **observed this session** (else the configured constant). SoC/range/capacity are treated as **capabilities**: the vehicle module supplies them today, but the resolver takes plain data, so a charger reporting SoC over the Type-2 wire could feed the same path later — and a loadpoint only offers the target units its data can back (`availableTargetUnits`).
6. **REST / MQTT** — reflect current loadpoint state to consumers
7. **Web UI** — subscribes to SSE, renders live state

## Core modules

### `src/core/config.ts`
Loads `osc.yaml`, validates against the zod schema, and returns a typed `Config` object. Does not cache — the config is immutable at runtime.

### `src/core/registry.ts`
A typed module registry. Modules call `registerCharger('ocpp16', factory)` at import time. The core looks up the right factory when instantiating configured modules.

### `src/core/plugin-loader.ts`
Scans `./plugins/*.js` at startup and imports each file. Plugins self-register by calling the SDK registration functions on import. Errors in one plugin are logged but don't crash the system.

### `src/core/events.ts`
A typed `EventEmitter` wrapper. Used for internal pub/sub (e.g., "loadpoint mode changed", "session started"). MQTT publishing is a subscriber to this bus, not the source.

### `src/core/db.ts`
Opens (or creates) `./data/osc.db` via `node:sqlite` (Node.js v22.5+ built-in). Runs migrations on startup. Exports typed query helpers — no raw SQL outside `db.ts`.

### `src/core/loadpoint.ts`
State machine per configured loadpoint. Holds `mode`, `targetSoc`, `targetTime`, `sessionEnergyKWh`. Mode is read from SQLite on boot and written back on every change.

### `src/core/planner.ts`
Given a set of price slots (hourly or 15-minute) and a required kWh amount, returns a binary on/off schedule for each slot that minimizes cost while finishing by `targetTime`. Falls back to a greedy "start as late as possible" if no price data is available.

### `src/core/estimator.ts`
Computes estimated SoC from `lastKnownSoc + (sessionKWhDelivered × chargingEfficiency / batteryCapacity)`. Accepts `batteryCapacity = undefined` and returns `undefined` in that case (caller handles). The efficiency is **observed within the session** (`observedEfficiency`, from two real readings with enough delta, clamped to a sane band) when available, else the configured constant — so a mid-session vehicle-API dropout keeps estimating SoC accurately and the charge still stops at the right point. Session-scoped only; nothing is learned across sessions.

### `src/core/health.ts`
Polls all registered modules' `health()` methods. Publishes to `osc/health/<module>` on MQTT and serves `GET /api/health`.

### `src/core/lifecycle.ts`
Entry point. Orchestrates: load config → open DB → load plugins → instantiate modules → start server → start balancer loops → register SIGINT/SIGTERM handlers for graceful shutdown.

## Module boundaries

Modules **must not** import from `src/core/` directly. They receive everything they need through `ModuleCtx` (from `src/sdk/`):

```ts
interface ModuleCtx {
  db: DatabaseSync
  events: EventEmitter
  log: Logger
  fetch: typeof globalThis.fetch  // jittered 0–120 s — PUBLIC scheduled data only (tariffs)
  mqtt?: { host: string; port: number; user?: string; password?: string }
}
```

First-party modules in `src/modules/*` use the same `ModuleCtx` as third-party plugins — same access, same constraints. The only difference is the registration wrapper (see [docs/modules.md](modules.md)).

**Modules are minimal mappers; the lifecycle owns orchestration.** A module translates one external service ⇄ SDK types on demand, actuates when told, and reports its own health — it owns **no** background timers, polling cadence, or cross-module coordination. Deciding *when* to poll a vehicle, driving the control tick, composing the resolver ladders, and (0.3.0) car↔charger association all live in the lifecycle. This is the codebase's most important boundary; the full statement and worked examples are in [AGENTS.md](../AGENTS.md) → "Modules vs. the lifecycle".

## OCPP connection model

Chargers connect over WebSocket to `ws://<host>:<port>/ocpp`. The `ocpp16` module registers a path handler. Each connecting charger is identified by its `stationId` (the last path segment or the OCPP CP identifier). A single `charger-ocpp16` module instance manages all connected chargers; the loadpoint is matched by the configured `stationId`.

## Persistence

SQLite at `./data/osc.db`. Tables:
- `loadpoint_state` — mode, targetSoc, targetTime, targetKWh, **minSoc** (ad-hoc target + safety floor) per loadpoint name
- `charge_plans` — recurring per-loadpoint plans (days_mask, ready_by, target value+unit, enabled); the resolution layer (`src/core/plans.ts`) in front of the planner
- `settings` — system-wide key/value (e.g. site `timezone`); `src/core/settings.ts`
- `transactions` — OCPP transaction records
- `meter_values` — raw meter value samples per session
- `tariff_slots` — cached price slots per (zone, slotStart)
- `vehicle_cache` — per-vehicle: SoC, capacity, range, fetchedAt

Migrations run automatically on startup (additive only — no destructive migrations).

**Two timezones (`src/sdk/local-time.ts`, tz always a parameter):** the **site** timezone
(`settings.timezone`, configurable + auto-detected in setup) drives all user-facing planning — the
night window, plan ready-by, targets. Tariff providers use their own **market** timezone (Nord Pool =
`Europe/Stockholm`) for publish windows + per-day price files, which follow the price market regardless
of where the user lives.
