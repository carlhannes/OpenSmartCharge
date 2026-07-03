# OpenSmartCharge

> Lean, modular EV smart-charging system for self-hosters.

OpenSmartCharge (OSC) is a minimalistic smart charging system that connects OCPP chargers to day-ahead electricity pricing, household load balancing, and vehicle state-of-charge data — without the complexity of a full home energy management system.

If you want something that handles solar, batteries, heat pumps, and 300 EV models out of the box, [EVCC](https://evcc.io) is excellent. OSC exists for people who want *just the smart charging part*, with a small codebase they can fully understand, run on a Raspberry Pi, and extend themselves.

## Features

- **OCPP 1.6J server** — any charger speaking OCPP 1.6J connects to it directly on your LAN
- **Day-ahead pricing** — Elering API covers SE1–SE4 (Swedish Nordpool zones) with no API key required. 15-minute slot resolution.
- **Household load balancing** — reads live per-phase currents from your Tibber Pulse natively (no Python sidecar required) or any DSMR/OBIS meter bridged to MQTT, distributes the available headroom between chargers
- **Vehicle SoC** — reads state-of-charge from Skoda/VW vehicles; plans charging to hit your target by departure time
- **Charge modes per charger** — `disabled` / `smart` / `fast`, changeable via UI, REST, or MQTT
- **Home Assistant ready** — MQTT auto-discovery; OSC appears in HA automatically with selects and sensors per charger
- **Modular** — every feature above is a module with a published TypeScript interface; write your own to add a different charger type, tariff source, or meter
- **Degradation-aware** — the system keeps charging safely when the internet, your pulse meter, or a vehicle API goes down. See [the degradation model](#when-things-break).

## Quickstart

**Requirements:** Docker, an OCPP 1.6J charger on your LAN, a Mosquitto-compatible MQTT broker. Running on a Raspberry Pi? See [docs/raspberry-pi.md](docs/raspberry-pi.md) for NTP clock-sync setup — clock accuracy matters for tariff slot bucketing.

```bash
# Clone and configure
git clone https://github.com/yourusername/opensmartcharge
cd opensmartcharge
cp osc.dist.yaml osc.yaml
nano osc.yaml   # set your zone, breaker size, charger station ID

# Start the broker
docker compose up mosquitto -d

# Run OSC (development)
npm install
npm run dev:all   # starts backend (port 8080) + Vite HMR (port 5173) with prefixed logs

# Or run backend and UI dev server separately:
# npm run dev      # backend only (tsx watch, auto-restarts on .ts changes)
# npm run dev:ui   # Vite HMR only, proxies /api + /events to :8080

# Production build + run:
npm run build     # tsc + vite build → dist/
npm start         # serves backend + bundled UI on port 8080

# Docker (full stack with MQTT broker):
# docker compose up
```

Point your OCPP charger at `ws://<your-host>:8080/ocpp/<stationId>` — the OCPP identity is the **trailing path segment** and must match a charger's `stationId` in `osc.yaml` (for Zaptec this is the charger's serial, which the charger appends automatically). The UI is at `http://localhost:5173` in dev or `http://localhost:8080` in production.

> Charger accepts commands but won't deliver power (`SuspendedEVSE` / `Current.Offered: 0`)? See **[docs/ocpp-smart-charging.md](docs/ocpp-smart-charging.md)** — OCPP charging-profile quirks and a debugging playbook.

**Before opening a PR:** run `npm run build && npm start` and verify the production UI matches what you see in dev. With a Mosquitto broker running (`docker compose up -d mosquitto`), also run `npm run smoke` to verify the OCPP+REST+MQTT integration end-to-end.

## Architecture

OSC has four module types and one core concept:

### Module types

| Type | What it does | Built-in |
|---|---|---|
| **Charger** | Speaks to hardware — sends `SetChargingProfile`, reads meter values | OCPP 1.6J |
| **Tariff** | Provides 15-min spot price slots | Elering (SE1–SE4) |
| **Balancer** | Decides how many amps each charger gets per tick | MQTT circuit |
| **Vehicle** | Reads state-of-charge | Skoda / VW |

Each module type has a [TypeScript interface in `src/sdk/`](src/sdk/). Third-party modules drop into the `./plugins/` directory and are loaded at startup — no code changes needed in OSC itself. See [the module authoring guide](docs/modules.md).

### Loadpoints

A **loadpoint** is the control unit that wraps a charger and connects it to a circuit, a tariff, and optionally a vehicle. It holds the **charge mode** (`disabled` / `smart` / `fast`) and the departure target.

The loadpoint is what you control — via the web UI, REST, or MQTT. The Charger module is just the hardware driver underneath.

### Control flow (smart mode)

```
[Elering API] → tariff slots → planner  ─┐
[Tibber Pulse] → MQTT → balancer tick    ─┤→ SetChargingProfile → [Charger]
[Skoda API]   → estimator → loadpoint    ─┘
```

The balancer runs every 15 seconds. It reads live per-phase currents from MQTT, subtracts house load from the main breaker, and distributes the remaining headroom across active loadpoints — weighted by mode, tariff window, and SoC target.

## When things break

OSC is designed around a two-tier model so that a bad internet day doesn't stop your car from charging.

**Tier 1 — always works (LAN-only):**
OCPP server, MQTT broker, balancer circuit math, web UI, SQLite.

**Tier 2 — internet-enhanced (optional):**
Day-ahead tariffs (Elering), vehicle SoC (Skoda API).

Every module reports a health status: `ok` / `degraded` / `unavailable`. The system keeps running under degradation:

| What breaks | What happens |
|---|---|
| Internet down | Balancer uses cached prices (yesterday's curve). Vehicle SoC estimated from last known value + session kWh delivered. Charging continues. |
| Tibber Pulse / MQTT meter feed stale | Balancer switches to a configured safe static current (`safeStaticCurrentA`) — conservative but meaningful. Fuses safe. |
| Vehicle API unreachable (never seen vehicle) | Planner falls back to time-based: start charging at the latest time that completes by departure. |
| Vehicle API unreachable (seen vehicle before) | Battery capacity is cached. Planner estimates current SoC from `lastKnownSoc + (sessionKWh / capacity)`. Full departure planning works. |
| Everything restored | Modules recover automatically. No restart needed. |

All degraded states are surfaced on the UI and on MQTT (`osc/health/<module>`).

## Configuration

Copy `osc.dist.yaml` to `osc.yaml` and edit. Full reference: [docs/config.md](docs/config.md).

### Credentials

`osc.yaml` is listed in `.gitignore` — **never commit it**. It may contain your MySkoda email and password in plain text.

```bash
chmod 600 osc.yaml   # restrict read access to your user only
```

Credentials are never logged. OSC redacts tokens in all debug output. If you are deploying on a shared machine, consider using a secrets manager or environment-variable injection (see [docs/config.md](docs/config.md)).

### Backup & restore

OSC stores all state in a single SQLite file (`data/osc.db`). Back it up while OSC is running:

```bash
npm run backup                         # → backups/osc-<timestamp>.db
npm run backup -- --out ~/my-backup.db # custom output path
```

Restore (OSC must be stopped first):

```bash
npm run restore -- --in backups/osc-2025-06-01T12-00-00.db
```

## REST API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/loadpoints` | List all loadpoints with live state |
| `POST` | `/api/loadpoints/:name/mode` | Set charge mode (`disabled`/`smart`/`fast`) |
| `POST` | `/api/loadpoints/:name/target` | Set target SoC and/or departure time |
| `POST` | `/api/loadpoints/:name/start` | RemoteStartTransaction |
| `POST` | `/api/loadpoints/:name/stop` | RemoteStopTransaction |
| `POST` | `/api/loadpoints/:name/profile` | One-shot current limit (`{"amps":N}`) |
| `POST` | `/api/loadpoints/:name/reset` | Soft/Hard `Reset` (`{"type":"Soft"}`) |
| `POST` | `/api/loadpoints/:name/clear-profile` | `ClearChargingProfile` (all) — see troubleshooting doc |
| `GET` | `/api/loadpoints/:name/composite-schedule` | Charger's effective computed limit (`?duration=sec`) |
| `GET` | `/api/tariffs/:name/prices` | Fetch price slots (`?from=&to=`) |
| `GET` | `/api/meters/:name` | Meter reader latest snapshot + health |
| `GET` | `/api/balancers/:name` | Balancer allocations + health |
| `GET` | `/api/vehicles/:name` | Vehicle SoC, capacity, health |
| `GET` | `/api/health` | Module health map |
| `GET` | `/events` | SSE stream of all state changes |

## MQTT topics

State (retained):
- `osc/loadpoints/<name>/mode` — current charge mode
- `osc/loadpoints/<name>/state` — JSON snapshot of loadpoint
- `osc/loadpoints/<name>/current_a` — current being delivered
- `osc/tariffs/<name>/now` — current price slot
- `osc/health/<module>` — module health

Commands (not retained):
- `osc/loadpoints/<name>/cmd/mode` — publish `smart`, `fast`, or `disabled`
- `osc/loadpoints/<name>/cmd/target` — publish JSON `{ "soc": 80, "time": "07:00" }`

Home Assistant MQTT discovery is published automatically at startup (disable with `mqtt.homeAssistantDiscovery: false` in config).

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the milestone breakdown.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The module authoring guide at [docs/modules.md](docs/modules.md) is the starting point if you want to add a new charger type, tariff source, or vehicle integration.

## License

MIT — see [LICENSE](LICENSE).
