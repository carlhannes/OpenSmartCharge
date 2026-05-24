# Writing a module

OSC has five module types defined as TypeScript interfaces in `src/sdk/`. The canonical references for "how to write one" are the shipped first-party modules in `src/modules/*/` — copy the structure, replace the domain logic.

## First-party vs plugin

The `{ type, create(cfg, ctx) { … } }` registration block is byte-for-byte identical in both. Only the wrapper differs:

**First-party** (code in this repo, under `src/modules/`):

```ts
import { registerTariff } from '../../sdk/registry-api.js'

registerTariff({
  type: 'my-tariff',
  create(cfg, ctx) { … }
})
```

`src/core/lifecycle.ts` side-effect-imports the module, which triggers registration. See `src/modules/tariff-elering/index.ts` for a complete example.

**Plugin** (drop a `.js` file in `./plugins/`):

```js
export default function(api) {
  api.registerTariff({
    type: 'my-tariff',
    create(cfg, ctx) { … }
  })
}
```

`src/core/plugin-loader.ts` scans `plugins/` on boot and calls each file's default export with an `api` object containing all five `registerXxx` functions. `opensmartcharge/sdk` is **not** a published npm package — plugins receive the API via this parameter, not from an import path.

## Quickstart

A complete working plugin:

```js
// plugins/my-tariff.js
export default function(api) {
  api.registerTariff({
    type: 'my-tariff',
    create(cfg, ctx) {
      return {
        id: cfg.name,
        start: async () => {},
        stop:  async () => {},
        health: () => 'ok',
        async prices(from, to) {
          return [{ start: from, end: to, pricePerKWh: 0.12, currency: 'SEK' }]
        },
      }
    },
  })
}
```

Then in `osc.yaml`:

```yaml
tariffs:
  - name: mine
    type: my-tariff
```

Start OSC — it scans `./plugins/*.js` at startup and loads your module automatically.

## The five interfaces

### `Charger` (`src/sdk/charger.ts`)

```ts
interface Charger {
  readonly id: string
  start(): Promise<void>
  stop(): Promise<void>
  setCurrentLimit(amps: number): Promise<void>
  health(): ModuleHealth
  onStatus(cb: (status: ChargerStatus) => void): () => void  // returns unsubscribe
}
```

`setCurrentLimit` is the key method — OSC calls this every balancer tick. It must be idempotent (safe to call with the same value repeatedly).

`onStatus` is the push channel: your module calls `cb` whenever the charger status changes (connected/disconnected, charging/idle, meter values). The callback receives a `ChargerStatus` snapshot.

Reference: `src/modules/charger-ocpp16/`

### `Tariff` (`src/sdk/tariff.ts`)

```ts
interface Tariff {
  readonly id: string
  start(): Promise<void>
  stop(): Promise<void>
  health(): ModuleHealth
  prices(from: Date, to: Date): Promise<TariffSlot[]>
}

interface TariffSlot {
  start: Date         // UTC, inclusive
  end: Date           // UTC, exclusive
  pricePerKWh: number // in currency below
  currency: string    // e.g. 'EUR'
}
```

Return slots at whatever resolution your data source provides (hourly is fine — Elering uses hourly). The planner ranges over slots, not fixed buckets, so resolution is transparent.

Return an empty array for time ranges where you have no data. The system falls back gracefully.

Reference: `src/modules/tariff-elering/`

### `Balancer` (`src/sdk/balancer.ts`)

```ts
interface Balancer {
  readonly id: string
  start(): Promise<void>
  stop(): Promise<void>
  health(): ModuleHealth
  tick(input: BalancerInput): Promise<BalancerOutput>
}

interface BalancerInput {
  loadpoints: LoadpointSnapshot[]
  timestamp: Date
}

interface BalancerOutput {
  allocations: Map<string, number>  // loadpointId → amps (0 = don't charge)
}
```

`tick` is called every `intervalSec` seconds. It must always return a valid `allocations` map — never throw. If meter data is stale or unavailable, return a safe fallback current (not zero, unless the loadpoint mode is `disabled`).

The `LoadpointSnapshot` includes these notable fields:

| Field | Description |
|---|---|
| `mode` | `disabled` / `smart` / `fast` |
| `maxCurrentA` | Per-loadpoint ceiling from charger config. Never exceed it. |
| `shouldChargeNow?` | Set by lifecycle for smart-mode loadpoints. `false` = expensive slot, allocate 0. `undefined` = charge. |
| `pricesAvailable` | Whether the tariff module has data. Informational. |
| `currentA` | What the charger is currently drawing. Add this back before re-distributing headroom (credit-back). |

Lifecycle sets `shouldChargeNow=false` for smart-mode loadpoints in expensive tariff slots; the balancer allocates 0 to those and distributes freed headroom to the remaining loadpoints.

### `Vehicle` (`src/sdk/vehicle.ts`)

```ts
interface Vehicle {
  readonly id: string
  health(): ModuleHealth
  getData(): Promise<VehicleData>
  getCachedCapacity(): number | undefined  // always fast (from SQLite cache)
}

interface VehicleData {
  soc: number              // 0–100 %
  batteryCapacity?: number // kWh (stable per VIN — cache this)
  range?: number           // km
  isCharging?: boolean
  fetchedAt: Date
}
```

**Cache battery capacity aggressively.** It's stable per VIN. Once you've read it, return it forever from `getCachedCapacity()` — it enables SoC estimation when the API is unreachable.

`getData()` should return cached data when the API is down. Set `health()` to `'degraded'` in that case and return `{ ...lastCached, fetchedAt: lastFetchTime }`. Never return `undefined` or throw when the API is temporarily unavailable.

### `MeterReader` (`src/sdk/meter-reader.ts`)

```ts
interface MeterSnapshot {
  powerW?: number  // instantaneous total active power, watts (positive = importing from grid)
  i1A?: number     // per-phase currents, amps
  i2A?: number
  i3A?: number
  timestamp: Date
}

interface MeterReader {
  readonly id: string
  start(): Promise<void>
  stop(): Promise<void>
  health(): ModuleHealth
  latest(): MeterSnapshot | null  // null = no frame received yet
  onSnapshot(cb: (s: MeterSnapshot) => void): () => void  // returns unsubscribe
}
```

`latest()` returning `null` means the reader has never seen a frame (report `'unavailable'`). A non-null snapshot that is older than `staleAfterSec` means the feed has stopped (report `'degraded'` but keep returning the last value).

`onSnapshot` is the push channel used by the balancer for in-process data flow — no MQTT round-trip needed.

Reference: `src/modules/meter-tibber-pulse/`

## `ModuleCtx`

Every `create(cfg, ctx)` factory receives a `ModuleCtx`:

```ts
interface ModuleCtx {
  db: DatabaseSync     // node:sqlite (Node 22.5+ built-in) — persistence
  events: EventEmitter // internal pub/sub
  log: Logger          // pino child, pre-scoped to your module name
  fetch: typeof globalThis.fetch  // drop-in fetch() with 0–120 s anti-thundering-herd jitter
  mqtt?: { host: string; port: number; user?: string; password?: string }
}
```

**`ctx.fetch` vs global `fetch`** — use `ctx.fetch` for all scheduled/periodic outbound HTTP calls (tariff fetches, vehicle polls). It adds a random 0–120 s jitter so multiple OSC instances on the same network don't slam upstream APIs at the same millisecond. For a fetch that must happen immediately at startup, use the global `fetch` directly. See `src/modules/tariff-elering/index.ts` for the pattern.

**`ctx.mqtt`** — opt-in. The OSC bridge's own MQTT client (publishing `osc/…` topics) is private to the bridge; modules that need MQTT open their own connection with these params. Fail loudly in `create()` if you need MQTT and `ctx.mqtt` is `undefined` — that's a configuration error, not a degradation scenario. See `src/modules/meter-tibber-pulse/index.ts` for an example.

**`ctx.db`** — your tables, your `CREATE TABLE IF NOT EXISTS` in `start()`. Don't collide with OSC core table names: `loadpoint_state`, `transactions`, `meter_values`, `tariff_slots`, `vehicle_cache`.

Use `ctx.log.info(...)`, `ctx.log.warn(...)`, etc. Don't use `console.log`.

## Module health

Return one of three values from `health()`:

| Value | Meaning |
|---|---|
| `'ok'` | All fresh data, operating normally |
| `'degraded'` | Serving stale or estimated data; operation continues but with reduced precision |
| `'unavailable'` | No data at all; module is offline |

Health is polled every 30 seconds and published to `osc/health/<module>` on MQTT and `GET /api/health` on REST. The system never stops based on module health — it just communicates the state.

## Registration functions

Passed to plugins via the `api` parameter; called directly by first-party modules:

```ts
api.registerCharger(module: ChargerModule): void
api.registerTariff(module: TariffModule): void
api.registerBalancer(module: BalancerModule): void
api.registerVehicle(module: VehicleModule): void
api.registerMeterReader(module: MeterReaderModule): void
```

The `type` string you pass (`type: 'my-tariff'`) must match the `type:` field in `osc.yaml`.

## TypeScript

If you write a plugin in TypeScript, compile to JS before dropping into `plugins/`. You can copy the interface types from `src/sdk/*.ts` directly into your plugin source — they have no runtime dependency on OSC, only on `pino`, `node:sqlite`, and `node:events` types you can re-declare yourself.
