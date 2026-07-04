# Configuration reference

Copy `osc.dist.yaml` to `osc.yaml` and edit. The file is gitignored.

## Top-level sections

### `site`

```yaml
site:
  name: "My Home"   # displayed in UI
  port: 8080        # HTTP server port (default: 8080)
```

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
    type: elering
    zone: SE3   # SE1 | SE2 | SE3 | SE4 (also EE | LV | LT | FI)
```

**Built-in types:** `elering`

**Elering specifics:**

- Fetches from the [Elering Nordpool API](https://dashboard.elering.ee/api) — no API key required.
- Prices are stored in **EUR/kWh** (Elering returns EUR/MWh; OSC divides by 1000). All zones are returned in one API call; OSC filters to your configured zone.
- **Fetch schedule**: Nordpool publishes next-day prices around 13:00 CET. OSC waits until **13:15 Europe/Stockholm** before trying to fetch tomorrow's data. If the fetch fails, OSC retries at +30 min, then +1 h, +2 h, +4 h, … until midnight Stockholm, then gives up for the day and retries tomorrow at 13:15. Don't be alarmed if `health` is `degraded` between midnight and 13:15 — this is expected.
- Scheduled fetches use `ctx.fetch` (0–120 s random jitter) so that multiple OSC instances on the same network don't all hit the Elering API at the same millisecond.

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

Optional. Enables SoC-aware departure planning.

```yaml
vehicles:
  - name: enyaq
    type: skoda
    username: "me@example.com"   # MySkoda account email
    password: "your-password"    # MySkoda account password
    vin: TMBABCDEF12345678       # 17-char VIN (uppercase)
```

**Built-in types:** `skoda`

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
    targetSoc: 80             # default charge target (%)
    targetTime: "07:00"       # daily departure time (HH:MM, local time)
                              # if omitted, smart mode charges as cheaply as possible
                              # without a time constraint
```

**Charge modes:**

| Mode | Behaviour |
|---|---|
| `disabled` | No charging. Balancer sets current to 0. |
| `smart` | Charges in the cheapest hours to reach `targetSoc` by `targetTime`. Falls back gracefully when data is missing. |
| `fast` | Charges at the maximum current allowed by the circuit, ignoring tariff and SoC target. |

The mode can be changed at any time via the UI, REST, or MQTT — it takes effect on the next balancer tick.

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
