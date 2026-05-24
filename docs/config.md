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
    zone: SE3   # SE1 | SE2 | SE3 | SE4
```

**Built-in types:** `elering`

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
    vin: "TMBXXXXXXXXXXXXXXX"
    credentials:
      user: "me@example.com"
      password: "secret"
```

**Built-in types:** `skoda`

Credentials are stored in `osc.yaml` which is gitignored. Keep it out of version control.

### `chargers[]`

OCPP charger registrations. The charger must be configured to connect to `ws://<host>:<port>/ocpp`.

```yaml
chargers:
  - name: garage
    type: ocpp16
    stationId: MYCHARGER01   # must match the chargepoint identifier configured in the charger
    maxA: 16                 # optional, default 16 — maximum current this charger may deliver
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
