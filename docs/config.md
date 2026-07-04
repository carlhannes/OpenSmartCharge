# Configuration reference

Copy `osc.dist.yaml` to `osc.yaml` and edit. The file is gitignored.

## Top-level sections

### `site`

```yaml
site:
  name: "My Home"   # displayed in UI
  port: 8080        # HTTP server port (default: 8080)
  mainBreakerA: 16  # optional — main fuse per phase (amps). Circuit ceiling for loadpoints
                    # WITHOUT a balancer; the smart-charging static current fallback sizes
                    # against it. A balancer, when configured, carries its own mainBreakerA.
  timezone: Europe/Stockholm  # optional (default Europe/Stockholm) — the SITE/user timezone for
                    # all wall-clock planning: the night window, plan "ready by" times, and
                    # departure targets. Seeds the DB; the UI setup flow auto-detects + overrides
                    # it (or PUT /api/settings). Tariff providers use their own market timezone,
                    # not this — Nord Pool day-ahead is always CET regardless of where you are.
```

### `smartCharging`

Optional. Tunes the control loop and the graceful-degradation fallbacks. Every field has a default, so the whole section can be omitted.

```yaml
smartCharging:
  controlIntervalSec: 30   # control-loop tick interval (5–60 s). Kept slow because a charger/car
                           # takes 15–30 s to act on a new limit; ticking faster just oscillates.
  deadbandA: 1             # only re-command the charger when the target moves ≥ this many amps
  nightWindow:             # assumed-cheap window (local Stockholm hours), used by the price and
    startHour: 23          # current fallbacks when no live/historical data is available
    endHour: 5
  nightMarginA: 3          # static night current = mainBreakerA − nightMarginA
  daytimeFraction: 0.5     # static day current   = mainBreakerA × daytimeFraction
  historicalDays: 3        # look-back for the historical price-average and worst-case-load rungs
  vehiclePollIntervalSec: 1800  # min spacing between vehicle SoC refreshes WHILE charging
                                # (300–3600 s, default 30 min). Never polled while idle — see vehicles[].
  chargingEfficiency: 0.92 # AC charge efficiency (0.5–1); tunes the between-poll SoC estimate
```

**How the fallbacks work.** Smart charging composes three independent resolvers, each degrading on its own — so nothing has to branch on which combination of dependencies is available:

- **Energy** (how much to add): live/estimated vehicle SoC → a fixed `targetKWh` → a duty-cycle heuristic.
- **Price** (when it's cheap): live day-ahead tariff → last-`historicalDays` average per hour-of-day → the static night window above.
- **Current** (how many amps): live meter headroom → worst-case household load per hour over the last `historicalDays` → a time-of-day static (night `mainBreakerA − nightMarginA`, day `mainBreakerA × daytimeFraction`), clamped to the charger's `maxA` and floored to 0 below the 6 A IEC minimum.

Because of this, **smart mode works with no balancer, no tariff, and no vehicle** — each is an enhancement, not a requirement.

### `mqtt`

```yaml
mqtt:
  host: localhost   # MQTT broker hostname or IP
  port: 1883        # default: 1883
  user: ""          # optional
  password: ""      # optional
  topicPrefix: osc  # all OSC topics live under this prefix
  homeAssistantDiscovery: true   # publish HA discovery payloads on startup
```

MQTT is required if you use the `mqtt-circuit` balancer. It is optional otherwise, but recommended for Home Assistant integration.

### `tariffs[]`

A list of tariff sources. Each gets a `name` used by loadpoints.

```yaml
tariffs:
  - name: home
    type: elprisetjustnu   # Swedish zones (SE1–SE4)
    zone: SE4              # SE1 | SE2 | SE3 | SE4
```

**Built-in types:** `elprisetjustnu` (Sweden), `elering` (Baltics + Finland)

Both providers publish the same Nord Pool day-ahead auction — pick the one that covers your bidding zone:

**`elprisetjustnu` (Sweden — SE1 | SE2 | SE3 | SE4):**

- Fetches from [elprisetjustnu.se](https://www.elprisetjustnu.se/elpris-api) — free, no API key.
- Prices stored in **SEK/kWh** at **15-minute** resolution (Nord Pool 15-min settlement).
- One JSON file per day per zone; tomorrow's file lands ~13:00 CET (a 404 before then is normal, not an error).

**`elering` (Baltics + Finland — EE | FI | LV | LT):**

- Fetches from the [Elering Nordpool API](https://dashboard.elering.ee/api) — no API key required.
- Prices stored in **EUR/kWh** (Elering returns EUR/MWh; OSC divides by 1000), hourly.
- **Elering does not publish Swedish zones** — for SE1–SE4 use `elprisetjustnu`.

**Shared fetch schedule (both providers):**

- Nordpool publishes next-day prices around 13:00 CET. OSC waits until **13:15 Europe/Stockholm** before fetching tomorrow's data. On failure it retries at +30 min, then +1 h, +2 h, +4 h, … until midnight Stockholm, then retries the next day at 13:15. `health` is `degraded` between midnight and 13:15 — this is expected.
- Scheduled fetches use `ctx.fetch` (0–120 s random jitter) so multiple OSC instances don't hit the API at the same millisecond.
- The Nord Pool schedule, `tariff_slots` persistence, and health logic are shared in `src/sdk/nordpool-tariff.ts`; each provider module only supplies its HTTP fetch+parse.

### `balancers[]`

A list of electrical circuits with their load balancing configuration.

```yaml
balancers:
  - name: house-main
    type: mqtt-circuit
    mainBreakerA: 25        # main fuse per phase, in amps
    phases: 3               # 1 or 3
    meterTopicPrefix: house # listens to <prefix>/i1_a, /i2_a, /i3_a
    safeStaticCurrentA: 10  # current per loadpoint when meter feed is stale
    meterStaleAfterSec: 60  # seconds of silence before switching to safe static
    intervalSec: 15         # control loop interval in seconds
```

**Built-in types:** `mqtt-circuit`

`safeStaticCurrentA` is the fallback when your Tibber Pulse or DSMR bridge stops publishing. It should be conservative enough that the house won't trip the breaker even at typical peak household load, but still meaningful enough to charge the car. A good starting point: `mainBreakerA − estimatedPeakHouseholdA − marginA`.

### `vehicles[]`

Optional. Enables SoC-aware departure planning. When a vehicle is wired to a loadpoint, the energy resolver uses the car's real State of Charge against its battery capacity (the `soc-capacity` rung) instead of the fixed-`targetKWh` fallback.

```yaml
vehicles:
  - name: enyaq
    type: skoda
    username: "me@example.com"   # MySkoda account email
    password: "your-password"    # MySkoda account password
    vin: TMBABCDEF12345678       # 17-char VIN (uppercase)
```

**Built-in types:** `skoda`

**What it exposes:** State of Charge (%), estimated range, the target SoC set in the car, the car's own plugged-in state (a cross-check of the OCPP status), and whether remote climate/preconditioning is running.

**Polling is demand-driven — the module owns no timer.** The lifecycle refreshes a vehicle **only when its charger reports connected**: once on connect (to anchor SoC/range) and then, while actively charging, at most every `smartCharging.vehiclePollIntervalSec` (default 30 min). It is **never polled while idle or unplugged** — polling MySkoda too often can wake and slowly drain the car, and hammering the account risks a server-side lockout. Between polls, SoC is estimated by carrying the last real reading forward by delivered energy (`chargingEfficiency`). The module honours `429`/`Retry-After` rate-limit responses.

**Finding the VIN:** it's on the MySkoda app vehicle page, the physical car (windscreen / door pillar), or the registration document. It must be the full 17 characters, uppercase.

Credentials are stored in `osc.yaml` which is gitignored. Keep it out of version control.

### `meterReaders[]`

Optional. Provides live household current and power data to the load balancer. Requires `mqtt:` to be configured.

```yaml
meterReaders:
  - name: house-pulse
    type: tibber-pulse
    subTopic: pulse        # MQTT topic where Pulse publishes DSMR frames (default: pulse)
    republishPrefix: house # optional: republish to <prefix>/{power_w,i1_a,i2_a,i3_a}
    staleAfterSec: 60      # seconds before health → degraded if no frame received (default: 60)
```

**Built-in types:** `tibber-pulse`

**tibber-pulse specifics:**

- Subscribes to the Tibber Pulse DSMR/OBIS MQTT stream. Parses active power (`1-0:1.7.0`) and per-phase current (`1-0:31.7.0`, `1-0:51.7.0`, `1-0:71.7.0`).
- Sends `batching_disable true` to the Pulse control topics (`pctrl`, `pulse/subscribe`) on connect and every 300 s to keep data flowing unbatched.
- Requires `mqtt:` configured in `osc.yaml` — the module opens its own connection to the same broker using the same credentials.
- `republishPrefix: house` reproduces the exact MQTT topic layout of the Python `pulse_bridge.py` sidecar (`house/power_w`, `house/i1_a`, …) for Home Assistant or Node-RED dashboards. Remove this field to disable the sidecar behaviour — the balancer reads meter data in-process instead.
- Health: `ok` while frames arrive within `staleAfterSec`; `degraded` if stale (last known values still returned); `unavailable` until the first frame after boot.

The `meterReader: <name>` field on `balancers[]` (M3) links a balancer to a meter reader by name for in-process data flow — no MQTT round-trip.

### `chargers[]`

OCPP charger registrations. The charger must be configured to connect to `ws://<host>:<port>/ocpp`.

```yaml
chargers:
  - name: garage
    type: ocpp16
    stationId: MYCHARGER01   # must match the chargepoint identifier configured in the charger
    maxA: 16                 # optional, default 16 — maximum current this charger may deliver
    phases: 3                # optional, default 3 — physical phases; sent as numberPhases in the charging profile
```

**Built-in types:** `ocpp16`

`maxA` is the ceiling used by the loadpoint when issuing `SetChargingProfile`. The balancer (M3) may set a lower value based on circuit headroom, but it will never exceed `maxA`.

### `loadpoints[]`

The control units — one per charger, connecting it to a circuit, tariff, and optional vehicle.

```yaml
loadpoints:
  - name: garage-loadpoint
    charger: garage           # must match a name in chargers[]
    vehicle: enyaq            # optional — must match a name in vehicles[]
    tariff: home              # optional — must match a name in tariffs[]
    balancer: house-main      # optional — must match a name in balancers[]
    defaultMode: smart        # disabled | smart | fast
    autoStart: true           # optional, default true — send RemoteStartTransaction when a
                              # vehicle plugs in (Preparing status). Set false to require
                              # app/RFID start on the charger itself.
                              # On by default because many cheap OCPP chargers won't initiate
                              # a transaction without it.
    targetSoc: 80             # default charge target (%) — used when a vehicle SoC is available
    targetTime: "07:00"       # daily departure time (HH:MM, site-local — see site.timezone)
                              # if omitted, smart mode charges as cheaply as possible
                              # without a time constraint
    targetKWh: 40             # optional — fixed energy to add per session (kWh). The energy
                              # fallback when there's no vehicle SoC (guest car / no app).
                              # UI offers 10–100 in steps of 10.
    minSoc: 25                # optional — minimum SoC (%) safety floor. In smart mode, if the
                              # car's SoC drops below this, OSC force-charges immediately
                              # (bypassing the price wait). No-op with no vehicle SoC.
```

`targetSoc`/`targetTime`/`targetKWh` are a single **ad-hoc** target — the fallback when no recurring [plan](#charging-plans) governs. They are also seeds (see [Config vs. runtime state](#config-vs-runtime-state-persist-wins--configapply)).

**Charge modes:**

| Mode | Behaviour |
|---|---|
| `disabled` | No charging. Current is set to 0. |
| `smart` | Charges in the cheapest hours to reach the energy target by `targetTime`. Works **with or without a balancer**, and falls back gracefully when tariff/vehicle/meter data is missing (see [`smartCharging`](#smartcharging)). |
| `fast` | Charges at the maximum current the circuit budget allows, ignoring tariff and SoC target. |

The mode can be changed at any time via the UI, REST, or MQTT — it takes effect immediately (an on-demand control-loop tick) and otherwise on the next tick (default 30 s).

### Config vs. runtime state (persist-wins + `config:apply`)

`defaultMode` and the `targetSoc`/`targetTime`/`targetKWh` fields are **seeds**, not live bindings. The database is the source of truth at runtime: a loadpoint's mode and targets are persisted, and changes you make via the UI/REST/MQTT **survive restarts and win over the config file**. So config values only take effect the *first* time a loadpoint is seen (a fresh DB); editing them in `osc.yaml` afterwards does nothing on its own.

To declaratively re-apply the config file onto the database — overwriting the persisted mode + targets (a target omitted in config is cleared) — run:

```bash
npm run config:apply    # reads osc.yaml (OSC_CONFIG) → writes data/osc.db (OSC_DATA_DIR)
```

It prints a before→after diff per loadpoint and exits; it does not start the server. Use it after editing `osc.yaml`, or to reset runtime tweaks back to the declared config. (`maxA` and `autoStart` are re-read from config on every boot and are not persisted.)

**It writes the database, so restart (or start) the server for it to take effect** — a running server holds its loadpoint state in memory and won't pick up the change until it reboots.

### Charging plans

Recurring, per-charger plans are the primary way to express intent — *"ready by 07:00 at 80% on weekdays."* Unlike the single ad-hoc target above, plans are **managed at runtime via the UI/API**, not `osc.yaml`, and live in the database (they're edited often, so they're not config).

Each plan has a weekday set (mon–sun), a **ready-by** time (site-local `HH:MM`), a **target** + unit (`pct` %, `km` range, or `kwh`), and an enabled toggle. A charger can have zero or several.

**Which plan governs now:** among *enabled* plans whose days include **today** with a **ready-by still later today**, the earliest ready-by wins. If none qualifies (wrong day, all passed, or no plans), OSC falls back to the loadpoint's ad-hoc `targetSoc`/`targetKWh`. A `km` target is converted to % via the car's live range/SoC ratio (needs a connected car; degrades gracefully without one).

Manage plans via REST under `/api/loadpoints/:name/plans` — `GET` (list), `POST` (create), `PUT /:id` (partial update), `DELETE /:id`. A plan body: `{ "days": ["mon","fri"], "readyBy": "07:00", "target": 80, "unit": "pct", "enabled": true }`.

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

balancers:
  - name: house-main
    type: mqtt-circuit
    mainBreakerA: 25
    meterTopicPrefix: house
    safeStaticCurrentA: 10

  - name: garage-sub
    type: mqtt-circuit
    mainBreakerA: 16
    meterTopicPrefix: garage
    safeStaticCurrentA: 8

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

| Variable | Default | Description |
|---|---|---|
| `OSC_CONFIG` | `./osc.yaml` | Path to config file |
| `OSC_DATA_DIR` | `./data` | Directory for SQLite database |
| `OSC_PLUGINS_DIR` | `./plugins` | Directory scanned for third-party modules |
| `LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error` |
