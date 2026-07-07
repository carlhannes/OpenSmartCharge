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

## Worked example: writing a tariff-static plugin

This walks through a complete plugin from an empty folder to a working tariff module. It returns a configurable flat rate for every slot — no HTTP, no database, no scheduling. That makes it the smallest possible thing that satisfies the `Tariff` interface and shows every pattern you need for a real plugin.

### 1. Create the plugin file

```
plugins/
  tariff-static.js     ← one file, drop it here
```

### 2. Write the plugin

```js
// plugins/tariff-static.js
export default function(api) {
  api.registerTariff({
    type: 'static',

    create(cfg, ctx) {
      // Each module validates its own config. `cfg` is typed as `unknown` —
      // the core config loader passes your osc.yaml fields through unchanged.
      const { name, pricePerKWh, currency = 'SEK' } = cfg
      if (!name || typeof pricePerKWh !== 'number') {
        throw new Error('tariff-static: config must have name and pricePerKWh (number)')
      }

      return {
        get id() { return name },

        async start() {
          ctx.log.info({ name, pricePerKWh }, 'tariff-static ready')
        },

        async stop() {},

        health() { return 'ok' },

        async prices(from, to) {
          // Generate 15-minute slots covering [from, to)
          const slots = []
          const cursor = new Date(Math.ceil(from.getTime() / (15 * 60_000)) * (15 * 60_000))
          while (cursor < to) {
            const slotEnd = new Date(cursor.getTime() + 15 * 60_000)
            slots.push({ start: new Date(cursor), end: slotEnd, pricePerKWh, currency })
            cursor.setTime(slotEnd.getTime())
          }
          return slots
        },
      }
    },
  })
}
```

### 3. Wire it in `osc.yaml`

```yaml
tariffs:
  - name: flat-rate
    type: static
    pricePerKWh: 0.15   # EUR/kWh; passed through cfg as-is
    # currency: EUR     # optional, defaults to SEK in the plugin above
```

The `type: static` must match the string you pass to `api.registerTariff({ type: 'static', … })`.

### 4. Verify it loaded

Start OSC (`npm run dev` or `npm start`) and check health:

```bash
curl -s http://localhost:8080/api/health | jq '."tariff-flat-rate"'
# → "ok"
```

### 5. Use it

```bash
curl -s 'http://localhost:8080/api/tariffs/flat-rate/prices?from=2025-06-01T00:00:00Z&to=2025-06-01T02:00:00Z' | jq '.[0]'
# → { "start": "2025-06-01T00:00:00.000Z", "end": "2025-06-01T00:15:00.000Z",
#     "pricePerKWh": 0.15, "currency": "SEK" }
```

### Config validation pattern

The core config schema in `src/core/config.ts` uses `.catchall(z.unknown())` for module arrays — every field beyond `name` and `type` passes through opaquely as `cfg: unknown`. Your module is responsible for validating what it needs. The canonical pattern (from `tariff-elering/index.ts:13-17`):

```js
const { name, zone } = cfg  // cast to expected shape
if (!name || !zone) {
  throw new Error('tariff-elering: config must have name and zone')
}
```

Throw a descriptive `Error` from `create()` on bad config — OSC logs it and aborts startup cleanly. Don't silently default missing required fields.

### Going further

Once you need HTTP, scheduling, or persistence, `src/modules/tariff-elering/` is the reference:

| Feature | File | Key pattern |
|---|---|---|
| Periodic fetch | `index.ts` | `setTimeout` + `clearTimeout` in `start`/`stop`; state captured by closure |
| `ctx.fetch` jitter | `index.ts:57` | Use `ctx.fetch` for scheduled calls; `globalThis.fetch` for immediate startup calls |
| SQLite persistence | `persistence.ts` | `ctx.db.prepare('INSERT OR REPLACE …').run(…)` in `start()`; `CREATE TABLE IF NOT EXISTS` once |
| Time-zone-safe scheduling | `scheduler.ts` | DST-safe Stockholm-time math; returns `{ delayMs, reason }` |
| Tri-state health | `index.ts` | `computeHealth()` — `'ok'` / `'degraded'` (stale cache) / `'unavailable'` (no data at all) |

## Promoting a plugin to first-party

When your plugin is ready to live in the OSC repo, the only changes are:

1. Move `plugins/tariff-static.js` → `src/modules/tariff-static/index.ts` (rewrite in TS, change the API parameter to a direct import).
2. Change the registration call:

```ts
// Before (plugin)
export default function(api) {
  api.registerTariff({ type: 'static', create(cfg, ctx) { … } })
}

// After (first-party)
import { registerTariff } from '../../sdk/registry-api.js'
registerTariff({ type: 'static', create(cfg, ctx) { … } })
```

3. Add one import line to `src/core/lifecycle.ts` (the side-effect import triggers registration):

```ts
import '../modules/tariff-static/index.js'
```

The `create(cfg, ctx)` factory itself is unchanged. See `src/core/lifecycle.ts:1-6` for the first-party import block.

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
  start(): Promise<void>
  stop(): Promise<void>
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

Lifecycle calls `vehicle.start()` once at boot; the module owns its own poll timer. Cache battery capacity to SQLite via `ctx.db` — it's stable per VIN and enables SoC estimation when the API is unreachable.

**Cache battery capacity aggressively.** Once you've read it, return it forever from `getCachedCapacity()`. `getData()` should return cached data when the API is down — set `health()` to `'degraded'` in that case. Never throw when the API is temporarily unavailable.

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
  log: Logger          // pino — the shared app logger; every line is captured to the Logs viewer
  fetch: typeof globalThis.fetch  // drop-in fetch() with 0–120 s anti-thundering-herd jitter
}
```

**`ctx.fetch` vs global `fetch`** — use `ctx.fetch` for all scheduled/periodic outbound HTTP calls (tariff fetches, vehicle polls). It adds a random 0–120 s jitter so multiple OSC instances on the same network don't slam upstream APIs at the same millisecond. For a fetch that must happen immediately at startup, use the global `fetch` directly. See `src/modules/tariff-elering/index.ts` for the pattern.

**MQTT-speaking modules carry their own `broker:`** — there is no `ctx.mqtt`. A meter reader that listens on a broker declares its own `broker: {host, port, user?, password?}` in its `meterReaders[]` entry and opens its own listen-only connection (parse it with `parseBroker()` from `src/sdk/broker.ts`; see `src/modules/meter-mqtt-phase`). OSC's *own* outbound publishing (state topics + Home Assistant discovery) is a separate concern configured under `mqttBridge:` — consuming a meter never makes OSC publish. Fail loudly in `create()` if a required broker is missing (that's what `parseBroker` does).

**`ctx.db`** — your tables, your `CREATE TABLE IF NOT EXISTS` in `start()`. Don't collide with OSC core table names: `loadpoint_state`, `transactions`, `meter_values`, `tariff_slots`, `vehicle_cache`.

**`ctx.log`** — log through it (`ctx.log.info(...)`, `.warn(...)`, `.debug(...)`, …), **not `console.log`**. Everything logged this way is captured to the runtime `logs` store and shown in the app's **Logs viewer** (Settings → Logs) — at every level (there's no minimum; logs rotate out by age, default 3 days). To get a clean **module label** on your lines, include a module-type field the capturer recognizes (`charger`/`vehicle`/`tariff`/`balancer`/`meter`/`loadpoint` — e.g. `ctx.log.info({ tariff: name }, 'ready')`) or set your own with `ctx.log.child({ module: 'my-mod' })`. `console.*` is *also* captured as a safety net (so a stray `console.log` from a dependency isn't lost) but arrives unlabeled — and a logger you construct yourself that writes straight to stdout is **not** captured. Prefer `ctx.log`.

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
