# Writing a module

OpenSmartCharge's four feature categories — chargers, tariffs, balancers, and vehicles — are each defined by a TypeScript interface in `src/sdk/`. You can add a new module for any of them without touching the OSC core.

## Quickstart

1. Create `plugins/my-module.js` (compiled JS — see note on TypeScript below)
2. In the file, import the registration function and call it:

```js
// plugins/my-tariff.js  (CommonJS or ESM — OSC loads both)
import { registerTariff } from 'opensmartcharge/sdk'   // peer dep

registerTariff({
  type: 'my-tariff',
  create(cfg, ctx) {
    return {
      id: cfg.name,
      health: () => 'ok',
      async prices(from, to) {
        // fetch price slots from wherever
        return [{ start: from, end: to, pricePerKWh: 0.12, currency: 'SEK' }]
      }
    }
  }
})
```

3. Add the module to your config:

```yaml
tariffs:
  - name: my-prices
    type: my-tariff
```

4. Start OSC — it scans `./plugins/*.js` on startup and your module is loaded automatically.

## TypeScript

Write in TypeScript, compile to JS before dropping into `plugins/`. The `opensmartcharge/sdk` package exports `.d.ts` types for all interfaces so your editor can check your module.

## The four interfaces

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

### `Tariff` (`src/sdk/tariff.ts`)

```ts
interface Tariff {
  readonly id: string
  health(): ModuleHealth
  prices(from: Date, to: Date): Promise<TariffSlot[]>
}

interface TariffSlot {
  start: Date         // UTC, inclusive
  end: Date           // UTC, exclusive (start + 15 min)
  pricePerKWh: number // in currency below
  currency: string    // e.g. 'SEK'
}
```

**Important:** return 15-minute slots. If your API returns hourly prices, expand them: one hour → four slots with identical prices. This is how the planner works internally.

Return an empty array for time ranges where you have no data. The system falls back gracefully.

### `Balancer` (`src/sdk/balancer.ts`)

```ts
interface Balancer {
  readonly id: string
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

`tick` is called every `intervalSec` seconds. It must always return a valid `allocations` map — never throw. If your meter data is stale or unavailable, return a safe fallback current (not zero, unless the loadpoint mode is `disabled`).

The `LoadpointSnapshot` in the input includes `mode`, `connected`, `charging`, `estimatedSoc`, `targetSoc`, `targetTime`, and `pricesAvailable`. Use them to decide who gets how many amps.

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

## `ModuleCtx`

Every factory receives a `ModuleCtx`:

```ts
interface ModuleCtx {
  db: DatabaseSync  // node:sqlite (Node.js v22.5+ built-in) — use it if your module needs persistence
  events: EventBus  // internal event bus — for publishing or subscribing to state changes
  log: Logger       // pino child logger — already scoped to your module name
}
```

Use `ctx.log.info(...)`, `ctx.log.warn(...)`, etc. Don't use `console.log`.

Use `ctx.db` to cache data (e.g., vehicle SoC history, price lookups). The OSC core handles migrations for its own tables; your module should create its own tables if needed, with a `CREATE TABLE IF NOT EXISTS` in its `start()` method.

## Module health

Return one of three values from `health()`:

| Value | Meaning |
|---|---|
| `'ok'` | All fresh data, operating normally |
| `'degraded'` | Serving stale or estimated data; operation continues but with reduced precision |
| `'unavailable'` | No data at all; module is offline |

Health is polled every 30 seconds and published to `osc/health/<module>` on MQTT and `GET /api/health` on REST. The system never stops based on module health — it just communicates the state.

## Registration functions (from `src/sdk/index.ts`)

```ts
registerCharger(module: ChargerModule): void
registerTariff(module: TariffModule): void
registerBalancer(module: BalancerModule): void
registerVehicle(module: VehicleModule): void
```

Call the appropriate one at module import time. The type string you pass (`type: 'my-tariff'`) must match the `type:` field in `osc.yaml`.
