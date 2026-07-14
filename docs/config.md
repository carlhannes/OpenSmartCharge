# Configuration reference

Copy `osc.dist.yaml` to `osc.yaml` and edit. The file is gitignored. It is an **import format**: OSC imports it into the database on first boot, after which the database is the source of truth and you edit via the API or re-import — see [The config model](#the-config-model-oscyaml-is-an-import-format).

## Top-level sections

### `site`

```yaml
site:
  name: 'My Home' # displayed in UI
  port: 8080 # HTTP server port (default: 8080)
  mainBreakerA:
    16 # optional — main fuse per phase (amps). Circuit ceiling for loadpoints
    # WITHOUT a balancer; the smart-charging static current fallback sizes
    # against it. A balancer, when configured, carries its own mainBreakerA.
  timezone:
    Europe/Stockholm # optional (default Europe/Stockholm) — the SITE/user timezone for
    # all wall-clock planning: the night window, plan "ready by" times, and
    # departure targets. Seeds the DB; the UI setup flow auto-detects + overrides
    # it (or PUT /api/settings). Tariff providers use their own market timezone,
    # not this — Nord Pool day-ahead is always CET regardless of where you are.
```

### `smartCharging`

Optional. Tunes the control loop and the graceful-degradation fallbacks. Every field has a default, so the whole section can be omitted.

```yaml
smartCharging:
  controlIntervalSec:
    30 # control-loop tick interval (5–60 s). Kept slow because a charger/car
    # takes 15–30 s to act on a new limit; ticking faster just oscillates.
  deadbandA: 1 # only re-command the charger when the target moves ≥ this many amps
  nightWindow: # assumed-cheap window (local Stockholm hours), used by the price and
    startHour: 23 # current fallbacks when no live/historical data is available
    endHour: 5
  nightMarginA: 3 # static night current = mainBreakerA − nightMarginA
  daytimeFraction: 0.5 # static day current   = mainBreakerA × daytimeFraction
  reserveA:
    1 # steady-state headroom below the fuse for the load-aware rungs: the
    # charger targets mainBreakerA − reserveA, so a load-step has room before
    # the fuse and steady state never sits at zero margin. 0 = ride the fuse.
  historicalDays: 3 # look-back for the historical price-average and worst-case-load rungs
  vehiclePollIntervalSec:
    900 # spacing between vehicle SoC refreshes WHILE drawing current
    # (300–3600 s, default 15 min); also the night-time idle rate
  vehicleIdlePollIntervalSec:
    600 # idle-poll spacing (plugged, not drawing) during the day window
    # below (60–1800 s, default 10 min); off-window uses the rate above.
    # Catches remote climate/plug changes; raise if you hit rate limits
  vehicleIdlePollDayWindow: # local hours [start, end) for the faster idle poll
    startHour: 6
    endHour: 22
  chargingEfficiency: 0.92 # AC charge efficiency (0.5–1) — fallback for the between-poll SoC estimate; each session refines it from its own real readings
```

**How the fallbacks work.** Smart charging composes three independent resolvers, each degrading on its own — so nothing has to branch on which combination of dependencies is available:

- **Energy** (how much to add): live/estimated vehicle SoC → a fixed `targetKWh` → a duty-cycle heuristic.
- **Price** (when it's cheap): live day-ahead tariff → last-`historicalDays` average per hour-of-day → the static night window above.
- **Current** (how many amps): live meter headroom → worst-case household load per hour over the last `historicalDays` → a time-of-day static (night `mainBreakerA − nightMarginA`, day `mainBreakerA × daytimeFraction`), clamped to the charger's `maxA` and floored to 0 below the 6 A IEC minimum. The two load-aware rungs target `mainBreakerA − reserveA`, so steady state sits a modest margin below the fuse; a brief overshoot is corrected on the next control tick rather than by steering faster (which would just oscillate the charger).

Because of this, **smart mode works with no balancer, no tariff, and no vehicle** — each is an enhancement, not a requirement.

### `mqttBridge`

Optional. OSC's **outbound** MQTT integration: it publishes OSC's own state, accepts commands, and (optionally) emits Home Assistant discovery. This is a **separate concern from meter readers** — those _listen_ on their own broker (see `meterReaders[]`); this is OSC _publishing_. Omit `mqttBridge` and OSC publishes nothing to any broker — a listen-only meter needs no `mqttBridge`.

```yaml
mqttBridge:
  broker:
    host: localhost # MQTT broker hostname or IP
    port: 1883 # default: 1883
    user: '' # optional
    password: '' # optional
  topicPrefix: osc # all OSC-published topics live under this prefix
  homeAssistantDiscovery: true # publish HA discovery payloads on startup
```

> **Migration.** The old combined top-level `mqtt:` block is gone (a boot WARNING fires if it's still present, and it's ignored). Inbound (a meter listening) moved onto `meterReaders[].broker`; outbound is `mqttBridge:`. Each carries its own `broker`, so reading a meter and publishing to a broker are fully independent.

### `tariffs[]`

A list of tariff sources. Each gets a `name` used by loadpoints.

```yaml
tariffs:
  - name: home
    type: elprisetjustnu # Swedish zones (SE1–SE4)
    zone: SE4 # SE1 | SE2 | SE3 | SE4
```

**Built-in types:** `elprisetjustnu` (Sweden), `elering` (Baltics + Finland), `fixed` (flat rate)

Both providers publish the same Nord Pool day-ahead auction — pick the one that covers your bidding zone:

**`elprisetjustnu` (Sweden — SE1 | SE2 | SE3 | SE4):**

- Fetches from [elprisetjustnu.se](https://www.elprisetjustnu.se/elpris-api) — free, no API key.
- Prices stored in **SEK/kWh** at **15-minute** resolution (Nord Pool 15-min settlement).
- One JSON file per day per zone; tomorrow's file lands ~13:00 CET (a 404 before then is normal, not an error).

**`elering` (Baltics + Finland — EE | FI | LV | LT):**

- Fetches from the [Elering Nordpool API](https://dashboard.elering.ee/api) — no API key required.
- Prices stored in **EUR/kWh** (Elering returns EUR/MWh; OSC divides by 1000), hourly.
- **Elering does not publish Swedish zones** — for SE1–SE4 use `elprisetjustnu`.

**`fixed` (flat rate — no spot pricing):**

```yaml
tariffs:
  - name: flat
    type: fixed
    pricePerKWh: 1.5 # every hour costs the same (default 0)
    # currency: SEK         # optional label (default SEK)
```

- For a fixed-price electricity contract. No network, no API key — `health` is always `ok`.
- Since every slot is equal-priced, smart mode charges **as early as possible** (soonest slots to hit the target/deadline) rather than waiting for a "cheap" window. Targets, `minSoc`, and climate-triggered charging all still apply.

**Shared fetch schedule (`elprisetjustnu` + `elering`):**

- Nordpool publishes next-day prices around 13:00 CET. OSC waits until **13:15 Europe/Stockholm** before fetching tomorrow's data. On failure it retries with **exponential backoff — 10 min → 20 → 40, capped at hourly** — and keeps retrying (it never backs off past midnight, so a transient blip can't strand prices for a day). `health` is `degraded` from the 13:15 window until tomorrow's data lands; before 13:15, having only today's data is fine.
- Scheduled fetches use `ctx.fetch` (0–120 s random jitter) so multiple OSC instances don't hit the API at the same millisecond.
- The Nord Pool schedule, `tariff_slots` persistence, and health logic are shared in `src/sdk/nordpool-tariff.ts`; each provider module only supplies its HTTP fetch+parse.

### `balancers[]`

A list of electrical circuits with their load balancing configuration.

```yaml
balancers:
  - name: house-main
    type: mqtt-circuit # splits the circuit across its loadpoints (name is legacy — see below)
    mainBreakerA: 25 # main fuse per phase, in amps — the hard ceiling for this circuit
    phases: 3 # 1 or 3
    meterReader: house-phase # live current from a meterReader (the meter SSoT); see meterReaders[]
    # Static time-of-day fallback margins, per-breaker. Used only when the meter is stale AND
    # there is no load history yet. Unset → global smartCharging.{nightMarginA,daytimeFraction}.
    # nightMarginA: 3        # night budget = mainBreakerA − this A
    # daytimeFraction: 0.5   # day budget   = mainBreakerA × this
    # reserveA: 1            # per-circuit fuse headroom; unset → global smartCharging.reserveA
```

**Built-in types:** `mqtt-circuit`

The balancer is a **pure splitter**: each tick it divides the circuit's already-resolved current budget across the loadpoints sharing it (fast-mode first, then an equal split of the remainder, with ±1 A hysteresis and the 6 A IEC floor). It holds **no meter and no timers** — the meter is a separate `meterReader` (the SSoT for live current _and_ its staleness), and the current-degradation ladder runs once per circuit in the control loop. When the meter's `health()` goes `degraded`/`unavailable` the whole circuit steps down the ladder (live-meter → historical-worstcase → static-tod); `nightMarginA`/`daytimeFraction` (falling back to the global `smartCharging.*`) size that bottom static rung. The `mqtt-circuit` type name is kept for config back-compat.

> **Migration.** The old self-contained meter fields — `meterTopicPrefix`, `safeStaticCurrentA`, `meterStaleAfterSec`, `intervalSec` — are deprecated (a boot WARNING fires if any is set) and otherwise ignored. Move the meter onto a `meterReaders[]` entry: replace `meterTopicPrefix: house` with a `type: mqtt-phase` reader (`topicPrefix: house`) and point the balancer's `meterReader:` at it. Replace the flat `safeStaticCurrentA` with `nightMarginA`/`daytimeFraction`; the control cadence is now the global `smartCharging.controlIntervalSec`.

### `vehicles[]`

Optional. Enables SoC-aware departure planning. When a vehicle is wired to a loadpoint, the energy resolver uses the car's real State of Charge against its battery capacity (the `soc-capacity` rung) instead of the fixed-`targetKWh` fallback.

```yaml
vehicles:
  - name: enyaq
    type: skoda
    username: 'me@example.com' # MySkoda account email
    password: 'your-password' # MySkoda account password
    vin: TMBABCDEF12345678 # 17-char VIN (uppercase)
```

**Built-in types:** `skoda`

**What it exposes:** State of Charge (%), estimated range, the target SoC set in the car, the car's own plugged-in state (a cross-check of the OCPP status), and whether remote climate/preconditioning is running.

**Polling is demand-driven — the module owns no timer.** The lifecycle refreshes a vehicle **only when its charger reports connected** (strictly per-car), on two cadences while plugged in: once on connect (to anchor SoC/range), then `smartCharging.vehiclePollIntervalSec` (default 15 min) while actively drawing current, and the faster `vehicleIdlePollIntervalSec` (default 10 min) while connected-but-idle **during the day window** — so remote climate/plug changes are caught promptly. Outside the day window the idle rate falls back to the 15-min cadence, and it is **never polled while unplugged** — polling MySkoda too often can wake and slowly drain a parked car, and hammering the account risks a server-side lockout. Between polls, SoC is estimated by carrying the last real reading forward by delivered energy — at the efficiency **observed this session** (measured from two real readings) when available, else `chargingEfficiency` — so a mid-session API dropout still tracks accurately. The module honours `429`/`Retry-After` rate-limit responses.

**Finding the VIN:** it's on the MySkoda app vehicle page, the physical car (windscreen / door pillar), or the registration document. It must be the full 17 characters, uppercase.

Credentials are stored in `osc.yaml` which is gitignored. Keep it out of version control.

### `meterReaders[]`

Optional. The **single source of truth for live household current** — a balancer (or bare loadpoint) sizes charger output below the main fuse from it, and its `health()`/`staleAfterSec` is the one authority on whether that data is fresh (when it goes stale, the circuit degrades down the current ladder). **Each reader carries its own `broker:`** and is listen-only — entirely separate from OSC's outbound `mqttBridge`, so consuming a meter never makes OSC publish anything.

```yaml
meterReaders:
  - name: house-phase
    type: mqtt-phase # raw per-phase amps on <topicPrefix>/i1_a, /i2_a, /i3_a
    topicPrefix: house # published by pulse_bridge.py or any DSMR/Modbus bridge (default: house)
    staleAfterSec: 60 # seconds before health → degraded if no frame received (default: 60)
    broker: # this reader's OWN broker (listen-only) — not OSC's outbound bridge
      host: 192.168.3.12
      port: 1883
      user: evcc
      password: ''
```

**Built-in types:** `mqtt-phase`, `tibber-pulse`

**mqtt-phase specifics:**

- The plain-per-phase reader: subscribes to `<topicPrefix>/i1_a`, `/i2_a`, `/i3_a` and emits a snapshot on each frame. This is the SSoT home for the legacy balancer `meterTopicPrefix` path — a garbage/non-numeric frame is ignored rather than clobbering the last good reading.
- Use it for any bridge that publishes bare per-phase amps. For a Tibber Pulse speaking DSMR directly, prefer `tibber-pulse` below (richer frames — active power too, plus keep-alive control).
- Health: `ok` while frames arrive within `staleAfterSec`; `degraded` if stale (last values still returned); `unavailable` until the first frame.

**tibber-pulse specifics:**

- Subscribes to the Tibber Pulse DSMR/OBIS MQTT stream. Parses active power (`1-0:1.7.0`) and per-phase current (`1-0:31.7.0`, `1-0:51.7.0`, `1-0:71.7.0`).
- Sends `batching_disable true` to the Pulse control topics (`pctrl`, `pulse/subscribe`) on connect and every 300 s to keep data flowing unbatched.
- Carries its own `broker:` block (host/port/user/password) — it opens its own listen-only connection, independent of OSC's outbound `mqttBridge`.
- `republishPrefix: house` reproduces the exact MQTT topic layout of the Python `pulse_bridge.py` sidecar (`house/power_w`, `house/i1_a`, …) for Home Assistant or Node-RED dashboards. Remove this field to disable the sidecar behaviour — OSC still consumes the meter in-process via the `meterReader:` link.
- Health: `ok` while frames arrive within `staleAfterSec`; `degraded` if stale (last known values still returned); `unavailable` until the first frame after boot.

The `meterReader: <name>` field on `balancers[]` is how a circuit gets its live current: it names the `meterReaders[]` entry to read, in-process (no MQTT round-trip through OSC). A balancer with no `meterReader` is a blind circuit — it skips the live rung and runs on the historical/static-tod fallbacks.

### `chargers[]`

OCPP charger registrations. The charger must be configured to connect to `ws://<host>:<port>/ocpp`.

```yaml
chargers:
  - name: garage
    type: ocpp16
    stationId: MYCHARGER01 # must match the chargepoint identifier configured in the charger
    maxA: 16 # optional, default 16 — maximum current this charger may deliver
    phases: 3 # optional, default 3 — physical phases; sent as numberPhases in the charging profile
    autoStartTransaction: true # optional, default true — auto-send RemoteStartTransaction on plug-in
```

**Built-in types:** `ocpp16`

`maxA` is the ceiling used by the loadpoint when issuing `SetChargingProfile`. The balancer (M3) may set a lower value based on circuit headroom, but it will never exceed `maxA`.

`autoStartTransaction` (default `true`) makes OSC send `RemoteStartTransaction` as soon as a car plugs in (the charger reports `Preparing`) — on by default because many chargers/cars won't open a transaction on their own. Set it `false` to require an app/RFID start on the charger.

### `loadpoints[]`

The control units — one per charger, connecting it to a circuit, tariff, and optional vehicle.

```yaml
loadpoints:
  - name: garage-loadpoint
    charger: garage # must match a name in chargers[]
    vehicle: enyaq # optional — must match a name in vehicles[]
    tariff: home # optional — must match a name in tariffs[]
    balancer: house-main # optional — must match a name in balancers[]
    defaultMode: smart # disabled | smart | fast
    targetSoc: 80 # default charge target (%) — used when a vehicle SoC is available
    targetTime:
      '07:00' # daily departure time (HH:MM, site-local — see site.timezone)
      # if omitted, smart mode charges as cheaply as possible
      # without a time constraint
    targetKWh:
      40 # optional — fixed energy to add per session (kWh). The energy
      # fallback when there's no vehicle SoC (guest car / no app).
      # UI offers 10–100 in steps of 10.
    minSoc:
      25 # optional — minimum SoC (%) safety floor. In smart mode, if the
      # car's SoC drops below this, OSC force-charges immediately
      # (bypassing the price wait). No-op with no vehicle SoC.
```

`targetSoc`/`targetTime`/`targetKWh` are a single **ad-hoc** target — the fallback when no recurring [plan](#charging-plans) governs. They are seeds imported into the database, which is then the runtime source of truth (see [The config model](#the-config-model-oscyaml-is-an-import-format)).

**Charge modes:**

| Mode       | Behaviour                                                                                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled` | No charging. Current is set to 0.                                                                                                                                                                                            |
| `smart`    | Charges in the cheapest hours to reach the energy target by `targetTime`. Works **with or without a balancer**, and falls back gracefully when tariff/vehicle/meter data is missing (see [`smartCharging`](#smartcharging)). |
| `fast`     | Charges at the maximum current the circuit budget allows, ignoring tariff and SoC target.                                                                                                                                    |

In `smart` mode two signals **force-charge**, overriding both the price wait and a reached target: a **`minSoc` floor** breach, and **remote climate/preconditioning running while the car is plugged in**. When climate is the _only_ reason to charge (battery already at target), OSC offers just the **6 A IEC minimum** — a car that draws preconditioning from the charger (e.g. Kia EV6) then runs it off the grid; how much it actually pulls is up to the car (some, like the Škoda Enyaq, run climate off the battery when at their charge limit and draw ≈nothing). OSC learns climate is on from the vehicle poll (faster during the day window; `POST /api/vehicles/:name/refresh` forces it immediately). `fast` and `disabled` ignore both (fast always charges; disabled never does).

The mode can be changed at any time via the UI, REST, or MQTT — it takes effect immediately (an on-demand control-loop tick) and otherwise on the next tick (default 30 s).

### The config model (osc.yaml is an import format)

The effective configuration OSC runs on is **`defaults ⊕ the database`**. The database config store — `config_overrides` (structural: entities + tuning), the `settings` KV (timezone, log retention), and `loadpoint_state` (mode + targets) — holds your complete non-default config; anything unset falls back to the schema default.

**`osc.yaml` is an import format, not a live base.** On a fresh (or cleared) database it is imported **once** to seed the config, then it is **inert** — editing the file alone does nothing afterwards. To change config after first boot you either **edit via the API** (applies live where possible) or **re-import** the file (`POST /api/config/import` or `npm run config:apply`).

So the API is the **complete editing surface** — every `osc.yaml` section has a write path:

| Section                            | Endpoint                                                   | Applies     |
| ---------------------------------- | ---------------------------------------------------------- | ----------- |
| `site` (name / mainBreakerA)       | `PUT /api/site`                                            | live        |
| `site.port`                        | `PUT /api/site`                                            | **restart** |
| `smartCharging.*`                  | `PUT /api/smartcharging`                                   | live        |
| `smartCharging.controlIntervalSec` | `PUT /api/smartcharging`                                   | **restart** |
| `mqttBridge`                       | `PUT /api/mqtt-bridge`                                     | **restart** |
| `tariffs[]`                        | `POST /api/tariffs`, `PUT /api/tariffs/:name`              | live        |
| `balancers[]`                      | `POST /api/balancers`, `PUT /api/balancers/:name`          | live        |
| `meterReaders[]`                   | `POST` / `PUT` / `DELETE /api/meters`                      | live        |
| `chargers[]`                       | `POST` / `PUT` / `DELETE /api/chargers`, `GET .../pending` | live        |
| `vehicles[]`                       | `POST` / `DELETE /api/vehicles`                            | live        |
| `loadpoints[]` bindings            | `PUT /api/loadpoints/:name`                                | live        |
| loadpoint mode / targets           | `POST /api/loadpoints/:name/mode`, `.../target`            | live        |

Every write is **validated against the same schema _before_ it is persisted** (a bad value is rejected with a 400, never stored to brick the next boot) and emits a `config.changed` SSE. A live change soft-reloads just the affected module — safe because durable state is in SQLite, desired state is re-derived each tick, and hardware re-reports observed state on reconnect. The **restart-required** fields are the handful captured once at boot: `smartCharging.controlIntervalSec` (the control-loop timer), `site.port` (the HTTP listener), and the whole `mqttBridge` (its live reload isn't wired yet). Those endpoints return `{ restartRequired: true, restartFields: [...] }`.

#### Import / export

- **`GET /api/config/export`** — the whole config as an `osc.yaml` document, **omitting schema defaults** so it stays small. Credentials are **redacted** by default; `?secrets=1` includes them (a full-fidelity backup). Served as a file download.
- **`POST /api/config/import`** — body `{ config, mode, dryRun? }`, where `config` is a YAML string or JSON object:
  - **`mode: "merge"`** overlays only the sections present (a partial import is fine); **`mode: "replace"`** is a blank slate — anything absent reverts to its default.
  - **`dryRun: true`** validates and reports without writing.
  - A **redacted** credential (the `••••••` placeholder) keeps the existing secret, so a redacted export round-trips without wiping passwords.
  - The document is validated **whole, before any write**, and applies on the **next restart** (a bulk swap, like `config:apply`); the granular `PUT`s above are the live path.
- **`npm run config:apply`** is the CLI form — read `osc.yaml` → import (replace): it **clears** the DB config and re-imports the file. Use it to re-assert the file or reset runtime tweaks. Reads `OSC_CONFIG`, writes `data/osc.db`; **restart the server to apply**.

#### What is config vs. data

Import/export covers **only configuration**, never history or cache:

- **Config** (exported / imported): `site`, `smartCharging`, `mqttBridge`, `tariffs`, `balancers`, `vehicles` (+creds), `chargers`, `meterReaders` (+broker creds), `loadpoints` (bindings + `defaultMode` + targets), `logs.retentionDays`.
- **Data** (never exported, untouched by import): charge transactions + meter samples, the tariff price cache, cached vehicle SoC, household-load history, the Škoda refresh token (re-auth from creds), OCPP counters, and logs.

Credentials in `config_overrides` / `osc.yaml` are **plaintext at rest** (unchanged posture); `chmod 700 data/`, treat backups as secret. `GET /api/config/export` (without `?secrets=1`) and `GET /api/site` redact them, and they are never logged.

> **Recurring charging plans** are runtime state, not config — managed via the UI/API and stored in the database (see [Charging plans](#charging-plans)). They are **not** part of import/export.

### Charging plans

Recurring, per-charger plans are the primary way to express intent — _"ready by 07:00 at 80% on weekdays."_ Unlike the single ad-hoc target above, plans are **managed at runtime via the UI/API**, not `osc.yaml`, and live in the database (they're edited often, so they're not config).

Each plan has a weekday set (mon–sun), a **ready-by** time (site-local `HH:MM`), a **target** + unit (`pct` %, `km` range, or `kwh`), and an enabled toggle. A charger can have zero or several.

**Which plan governs now:** among _enabled_ plans whose days include **today** with a **ready-by still later today**, the earliest ready-by wins. If none qualifies (wrong day, all passed, or no plans), OSC falls back to the loadpoint's ad-hoc `targetSoc`/`targetKWh`. A `km` target is converted to % via the car's live range/SoC ratio (needs a connected car; degrades gracefully without one).

Manage plans via REST under `/api/loadpoints/:name/plans` — `GET` (list), `POST` (create), `PUT /:id` (partial update), `DELETE /:id`. A plan body: `{ "days": ["mon","fri"], "readyBy": "07:00", "target": 80, "unit": "pct", "enabled": true }`.

Each returned plan also carries **`resolvedSoc`** — the backend-computed display SoC% (`pct`→value; `km`→via the car's range/SoC ratio; `kwh` or no car → `null`) — so clients display it rather than recompute the km→% conversion. `GET /api/loadpoints` exposes **`availableTargetUnits`** per loadpoint (which units the loadpoint's data can back right now: `kwh` always, `pct` with SoC + capacity, `km` also with range), so a client only offers a unit it can actually charge to.

## Multiple grids and chargers

All sections are lists. Add more entries to support multiple tariff zones, circuits, or chargers:

```yaml
tariffs:
  - name: home
    type: elering
    zone: SE3
  - name: cabin
    type: elering
    zone: SE2

meterReaders:
  - name: house-phase
    type: mqtt-phase
    topicPrefix: house
  - name: garage-phase
    type: mqtt-phase
    topicPrefix: garage

balancers:
  - name: house-main
    type: mqtt-circuit
    mainBreakerA: 25
    meterReader: house-phase

  - name: garage-sub
    type: mqtt-circuit
    mainBreakerA: 16
    meterReader: garage-phase

chargers:
  - name: wallbox-a
    type: ocpp16
    stationId: WB001
  - name: wallbox-b
    type: ocpp16
    stationId: WB002

loadpoints:
  - name: car-a
    charger: wallbox-a
    tariff: home
    balancer: house-main
    defaultMode: smart
    targetSoc: 80
  - name: car-b
    charger: wallbox-b
    tariff: home
    balancer: garage-sub
    defaultMode: smart
    targetSoc: 80
```

## Environment variables

| Variable          | Default      | Description                                   |
| ----------------- | ------------ | --------------------------------------------- |
| `OSC_CONFIG`      | `./osc.yaml` | Path to config file                           |
| `OSC_DATA_DIR`    | `./data`     | Directory for SQLite database                 |
| `OSC_PLUGINS_DIR` | `./plugins`  | Directory scanned for third-party modules     |
| `LOG_LEVEL`       | `info`       | `trace` / `debug` / `info` / `warn` / `error` |
