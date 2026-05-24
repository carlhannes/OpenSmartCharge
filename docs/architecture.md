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
3. **Tariff module** — fetches day-ahead prices from Elering, stores in SQLite; exposes `prices(from, to)`
4. **Balancer tick** (every `intervalSec`):
   a. Reads live per-phase currents from a `MeterReader` module (in-process `latest()` snapshot) or, if no MeterReader is configured, subscribes to `house/i1_a`, `i2_a`, `i3_a` MQTT topics directly
   b. Calls `planner.schedule(loadpoint, priceSlots, estimatedSoc)` for each active smart-mode loadpoint
   c. Computes headroom: `mainBreakerA − max(housePhaseCurrents) + sum(chargerCurrents)`
   d. Distributes headroom across loadpoints per planner output
   e. Calls `charger.setCurrentLimit(amps)` for each
5. **Vehicle polling** (every 15 min) — reads SoC from Skoda API, caches to SQLite
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
Given a set of 15-min price slots and a required kWh amount, returns a binary on/off schedule for each slot that minimizes cost while finishing by `targetTime`. Falls back to a greedy "start as late as possible" if no price data is available.

### `src/core/estimator.ts`
Computes estimated SoC from `lastKnownSoc + (sessionKWhDelivered × chargingEfficiency / batteryCapacity)`. Accepts `batteryCapacity = undefined` and returns `undefined` in that case (caller handles).

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
  fetch: typeof globalThis.fetch  // jittered (0–120 s)
  mqtt?: { host: string; port: number; user?: string; password?: string }
}
```

First-party modules in `src/modules/*` use the same `ModuleCtx` as third-party plugins — same access, same constraints. The only difference is the registration wrapper (see [docs/modules.md](modules.md)).

## OCPP connection model

Chargers connect over WebSocket to `ws://<host>:<port>/ocpp`. The `ocpp16` module registers a path handler. Each connecting charger is identified by its `stationId` (the last path segment or the OCPP CP identifier). A single `charger-ocpp16` module instance manages all connected chargers; the loadpoint is matched by the configured `stationId`.

## Persistence

SQLite at `./data/osc.db`. Tables:
- `loadpoint_state` — mode, targetSoc, targetTime per loadpoint name
- `transactions` — OCPP transaction records
- `meter_values` — raw meter value samples per session
- `tariff_slots` — cached price slots per (zone, slotStart)
- `vehicle_cache` — per-vehicle: SoC, capacity, odometer, fetchedAt

Migrations run automatically on startup (additive only — no destructive migrations).
