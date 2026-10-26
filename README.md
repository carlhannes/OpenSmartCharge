# OpenSmartCharge

> Lean, modular EV smart-charging system for self-hosters.

OpenSmartCharge (OSC) is a minimalistic smart charging system that connects OCPP chargers to day-ahead electricity pricing, household load balancing, and vehicle state-of-charge data — without the complexity of a full home energy management system.

If you want something that handles solar, batteries, heat pumps, and 300 EV models out of the box, [EVCC](https://evcc.io) is excellent. OSC exists for people who want *just the smart charging part*, with a small codebase they can fully understand, run on a Raspberry Pi, and extend themselves.

## Features

- **OCPP 1.6J server** — any charger speaking OCPP 1.6J connects to it directly on your LAN
- **Day-ahead pricing** — Swedish zones (SE1–SE4) via elprisetjustnu.se at 15-minute resolution; the Baltics + Finland (EE/FI/LV/LT) via the Elering API. No API key required.
- **Household load balancing** — reads live per-phase currents from your Tibber Pulse natively (no Python sidecar required) or any DSMR/OBIS meter bridged to MQTT, distributes the available headroom between chargers
- **Vehicle SoC** — reads state-of-charge from Skoda/VW vehicles; plans charging to hit your target by departure time
- **Charge modes per charger** — `disabled` / `smart` / `fast`, changeable via UI, REST, or MQTT
- **Home Assistant ready** — MQTT auto-discovery; OSC appears in HA automatically with selects and sensors per charger
- **Modular** — every feature above is a module with a published TypeScript interface; write your own to add a different charger type, tariff source, or meter
- **Degradation-aware** — the system keeps charging safely when the internet, your pulse meter, or a vehicle API goes down. See [the degradation model](#when-things-break).

## Quickstart

**Requirements:** Docker, an OCPP 1.6J charger on your LAN, a Mosquitto-compatible MQTT broker. Running on a Raspberry Pi? See [docs/raspberry-pi.md](docs/raspberry-pi.md) for NTP clock-sync setup — clock accuracy matters for tariff slot bucketing.

### One-line install (dedicated Linux box)

On a fresh Debian/Ubuntu box, install and run OSC as a systemd service in one command:

```bash
curl -fsSL https://raw.githubusercontent.com/carlhannes/OpenSmartCharge/main/setup.sh | bash
```

It installs Node 24, a Mosquitto broker, and NTP time-sync; clones + builds the repo; and registers a
hardened systemd service (`osc`) that runs as a dedicated **unprivileged `osc` user** under
`/opt/opensmartcharge` (never root) and starts on boot. It is **idempotent** — re-run it any time to upgrade to the
latest `main`; your configuration (`osc.yaml`) and data (`data/osc.db`) are never touched. Then open
`http://<box>:8080` and complete the onboarding. `--dry-run` previews changes and `--ref <tag>` pins a
version. (Piping to `bash` runs code as it downloads — read the script first if you prefer.)

### From source (Docker / development)

```bash
# Clone and configure
git clone https://github.com/carlhannes/OpenSmartCharge
cd OpenSmartCharge
cp osc.dist.yaml osc.yaml
nano osc.yaml   # set your zone, breaker size, charger station ID

# Start the broker
docker compose up mosquitto -d

# Run OSC (development)
npm install
npm --prefix src/ui2 install   # the UI has its own package.json
npm run dev:all   # backend (port 8080) + ui2 dev server (Vite HMR, port 5174), prefixed logs

# Or run backend and the UI dev server separately:
# npm run dev      # backend only (tsx watch, auto-restarts on .ts changes)
# npm run dev:ui2  # ui2 dev server (Vite HMR on :5174), proxies /api + /events to :8080

# Production build + run:
npm run build     # tsc (backend) + ui2 static SPA → dist/
npm start         # serves backend + ui2 on port 8080

# Docker (full stack with MQTT broker):
# docker compose up
```

Point your OCPP charger at `ws://<your-host>:8080/ocpp/<stationId>` — the OCPP identity is the **trailing path segment** and must match a charger's `stationId` in `osc.yaml` (for Zaptec this is the charger's serial, which the charger appends automatically). The UI is at `http://localhost:5174` in dev or `http://localhost:8080` in production.

> Charger accepts commands but won't deliver power (`SuspendedEVSE` / `Current.Offered: 0`)? See **[docs/ocpp-smart-charging.md](docs/ocpp-smart-charging.md)** — OCPP charging-profile quirks and a debugging playbook.

**Before opening a PR:** run `npm run build && npm start` and verify the production UI matches what you see in dev. With a Mosquitto broker running (`docker compose up -d mosquitto`), also run `npm run smoke` to verify the OCPP+REST+MQTT integration end-to-end.

## Architecture

OSC has five module types and one core concept:

### Module types

| Type | What it does | Built-in |
|---|---|---|
| **Charger** | Speaks to hardware — sends `SetChargingProfile`, reads meter values | OCPP 1.6J |
| **Tariff** | Provides day-ahead spot price slots | elprisetjustnu (SE1–SE4), Elering (EE/FI/LV/LT), fixed (flat rate) |
| **Balancer** | Splits a circuit's current budget across its chargers each tick | MQTT circuit |
| **Vehicle** | Reads state-of-charge, range, plug and climate state | Skoda / VW, manual (no API) |
| **Meter reader** | Reads live household current — the one source of truth for load balancing | MQTT per-phase, Tibber Pulse (DSMR) |

Each module type has a [TypeScript interface in `src/sdk/`](src/sdk/). Third-party modules drop into the `./plugins/` directory and are loaded at startup — no code changes needed in OSC itself. See [the module authoring guide](docs/modules.md).

Modules stay **minimal mappers** to a single external service — they translate data on demand, actuate when told, and report their own health; they own no timers or scheduling. The **core lifecycle owns all orchestration**: the control loop, when to poll a vehicle, and how the pieces combine. (See [AGENTS.md](AGENTS.md) → "Modules vs. the lifecycle".)

### Loadpoints

A **loadpoint** is the control unit that wraps a charger and connects it to a circuit, a tariff, and optionally a vehicle. It holds the **charge mode** (`disabled` / `smart` / `fast`) and the departure target.

The loadpoint is what you control — via the web UI, REST, or MQTT. The Charger module is just the hardware driver underneath.

### Control flow (smart mode)

```
[Elering API] → tariff slots → planner  ─┐
[Tibber Pulse] → meter reader → budget   ─┤→ SetChargingProfile → [Charger]
[Skoda API]   → estimator → loadpoint    ─┘
```

Each control tick, OSC resolves the circuit's available current — the main breaker minus live house load read from the meter reader, degrading to a last-few-days worst-case or a time-of-day static when the meter is stale — and the balancer splits that budget across the active loadpoints, weighted by mode, tariff window, and SoC target.

## When things break

OSC is designed around a two-tier model so that a bad internet day doesn't stop your car from charging.

**Tier 1 — always works (LAN-only):**
OCPP server, MQTT broker, balancer circuit math, web UI, SQLite.

**Tier 2 — internet-enhanced (optional):**
Day-ahead tariffs (elprisetjustnu / Elering), vehicle SoC (Skoda API).

Every module reports a health status: `ok` / `degraded` / `unavailable`. The system keeps running under degradation:

| What breaks | What happens |
|---|---|
| Internet down | Balancer uses cached prices (yesterday's curve). Vehicle SoC estimated from last known value + session kWh delivered. Charging continues. |
| Tibber Pulse / MQTT meter feed stale | The circuit steps down the current ladder — last-few-days worst-case household load, then a time-of-day static (night `mainBreakerA − nightMarginA`, day `mainBreakerA × daytimeFraction`). Conservative but meaningful. Fuses safe. |
| Vehicle API unreachable (never seen vehicle) | Planner falls back to time-based: start charging at the latest time that completes by departure. |
| Vehicle API unreachable (seen vehicle before) | Battery capacity is cached. Planner estimates current SoC from `lastKnownSoc + (sessionKWh / capacity)`. Full departure planning works. |
| Everything restored | Modules recover automatically. No restart needed. |

All degraded states are surfaced on the UI and on MQTT (`osc/health/<module>`).

## Configuration

Copy `osc.dist.yaml` to `osc.yaml` and edit. Full reference: [docs/config.md](docs/config.md).

### Runtime configuration (declarative)

`osc.yaml` is an **import format**, not the live config. On the first boot of a fresh (or cleared)
database OSC imports it once; from then on the **database is the source of truth**. Structural config —
tariff region, main breaker, balancer params, claiming a newly-connected charger, adding a vehicle — is
edited at runtime through the API/UI. Each write is validated against the same schema, persisted
(`config_overrides` / `settings` / `loadpoint_state`), and applied by **soft-reloading just the affected
module** — no process restart. To re-assert an edited `osc.yaml`, re-import it: `npm run config:apply`
(clears the stored config and imports the file; restart afterwards) or `POST /api/config/import` (merge
by default). This declarative model — desired state in the DB, the running system continuously
reconciling toward it — is also what keeps charging resilient to flaky connectivity (see
[AGENTS.md](AGENTS.md) → "Declarative config & soft-reload").

### Credentials

`osc.yaml` is listed in `.gitignore` — **never commit it**. It may contain your MySkoda email and password in plain text.

```bash
chmod 600 osc.yaml   # restrict read access to your user only
```

Credentials are never logged. OSC redacts tokens in all debug output. If you are deploying on a shared machine, consider using a secrets manager or environment-variable injection (see [docs/config.md](docs/config.md)).

Vehicle credentials added at runtime via the API (the car onboarding flow) are stored in `data/osc.db` — the same plaintext-at-rest posture as `osc.yaml`, so `chmod 700 data/` and treat backups as secret. They are never returned by the API (`GET /api/site` exposes only `name`/`type`/`vin`) or written to logs. Encryption-at-rest is a planned improvement.

### Backup & restore

Two levels. The **UI** (Settings → System → Backup & restore) exports/imports just your
**configuration** as an `osc.yaml` file — chargers, vehicles, tariffs, breaker, plans, timezone, with an
optional *"include credentials"* — and applies it on a restart you can trigger from the same screen (or
from the onboarding welcome screen's *"import a backup"*). For a **full** snapshot including charging
history, back up the SQLite database from the CLI:

OSC stores all state in a single SQLite file (`data/osc.db`). Back it up while OSC is running:

```bash
npm run backup                         # → backups/osc-<timestamp>.db
npm run backup -- --out ~/my-backup.db # custom output path
```

Both scripts use `$OSC_DATA_DIR` (default `./data`) like the server; `--data <dir>` overrides it.

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
| `POST` | `/api/vehicles/:name/refresh`, `/api/tariffs/:name/refresh` | Force one live fetch now (manual recovery) |
| `GET` | `/api/health` | Module health map |
| `GET` | `/api/site` | The effective config topology (chargers, loadpoints, vehicles, tariffs, balancers, meters) — credentials redacted |
| `GET` | `/api/plans`, `/api/loadpoints/:name/plans` | Recurring charging plans (all / per loadpoint); `POST`/`PUT /:id`/`DELETE /:id` per loadpoint — see [docs/config.md](docs/config.md#charging-plans) |
| `GET` | `/api/loadpoints/:name/plan` | The planner's current forward schedule + prices (what the charger chart renders) |
| `POST` | `/api/loadpoints/:name/vehicle` | Sticky active-vehicle override (`{"vehicle": null \| "guest" \| "<name>"}`) |
| `GET` | `/api/chargers/pending` | OCPP stations connected but not yet claimed; `POST /api/chargers` claims one (charger + loadpoint) |
| `GET` | `/api/transactions`, `/api/transactions/:id` | Charging-session history (`?loadpoint=&limit=`) + per-session meter samples |
| `GET` | `/api/power-history` | Rolling 15-min whole-house + car power buffer (the Home chart) |
| `GET` | `/api/logs` | Runtime logs, newest first (`?level=` minimum severity, `since=`/`until=` ISO, `q=` substring, `limit=` ≤ 500); `GET /api/logs/export` = the same filters as a chronological `.log` download; `GET`/`PUT /api/logs/config` = `{ "retentionDays": 1–365 }` |
| `GET` | `/api/config/export` | The config as YAML (`?secrets=1` for a full-fidelity backup); `POST /api/config/import` re-imports one — see [docs/config.md](docs/config.md) |
| `POST` | `/api/system/restart`, `/api/system/reset` | Graceful restart (a supervisor brings OSC back) / wipe the database and restart |
| `GET` | `/events` | SSE stream of all state changes (see below) |

Config writes (`PUT /api/site`, `/api/smartcharging`, `/api/tariffs/:name`, `/api/balancers/:name`, `/api/chargers/:name`, `/api/vehicles/:name`, `/api/loadpoints/:name`, …) are documented in [docs/config.md](docs/config.md#the-config-model-oscyaml-is-an-import-format).

Live updates stream over Server-Sent Events at `GET /events`: `loadpoint.state` / `.mode` / `.target` / `.resolve` / `.session` / `.plans`, `vehicle.poll`, `meter.snapshot`, `balancer.tick`, `tariff.updated`, `health.changed`, `config.changed`, `settings.changed`.

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

Home Assistant MQTT discovery is published automatically at startup (disable with `mqttBridge.homeAssistantDiscovery: false` in config).

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the milestone breakdown.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The module authoring guide at [docs/modules.md](docs/modules.md) is the starting point if you want to add a new charger type, tariff source, or vehicle integration.

## License

MIT — see [LICENSE](LICENSE).
