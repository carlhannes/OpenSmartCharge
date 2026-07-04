# AGENTS.md — Guide for AI agents working on OpenSmartCharge

This file captures the decisions, principles, and conventions established for this codebase. Read it before making any changes.

## Project north star

OpenSmartCharge is a **lean, modular, LAN-survivable** EV smart-charging system. The goal is a codebase that a single developer can fully understand, run on a Raspberry Pi, and extend in 2 years without needing to re-learn how it works.

**Lean**: Every feature is justified. Ask "is there a simpler way?" before adding. No early optimization, no caches unless required, no abstractions for hypothetical future needs.

**Modular**: Features live in modules (`src/modules/`). The core (`src/core/`) handles orchestration only. Module interfaces live in `src/sdk/`. First-party modules are reference implementations — readable enough for a third party to copy and adapt.

**LAN-survivable**: Charging must continue when the internet is down. Internet-dependent modules (tariff, vehicle) are optional enhancements. See the degradation model.

---

## Collaboration principles

These were established at project start and apply to all changes:

1. **Single source of truth** — no duplicated logic/files. When refactoring, remove the old version.
2. **KISS** — simplest solution first. Three clear lines beat a clever abstraction.
3. **DRY** — generalize when something appears in 2+ places, but wait until it actually repeats.
4. **Separation of Concerns** — organized and modular, but don't over-engineer prematurely.
5. **Functional TypeScript** — use functions, not classes. No OOP patterns in TS. Work with the language.
6. **Modify, don't rewrite** — prefer moving/copying + modifying files over read+rewrite from scratch. Use git or bash if you need to copy a file before modifying.
7. **Rationale first** — state assumptions and rationale before making changes.
8. **No comments that describe what** — code names should do that. Comments only for *why* (a hidden constraint, a subtle invariant, a workaround).
9. **Update docs** — when changing something that's documented, update the docs in the same commit.
10. **Run the tools** — after file edits, run `npm run format && npm run typecheck && npm run lint` and fix all errors before reporting done.
11. **Sanity-check** — after completing a task, randomly pick one modified file and re-read it as a stranger would. State what you find.

---

## Architecture

### Directory layout

```
src/
  core/       — config, registry, plugin-loader, events, db, logger,
                loadpoint, planner, estimator, health, lifecycle
  sdk/        — TypeScript interfaces for all four module types + ModuleCtx
  modules/    — first-party reference modules
    charger-ocpp16/
    tariff-elering/          (EE/FI/LV/LT)
    tariff-elprisetjustnu/   (SE1–SE4)
    balancer-mqtt-circuit/
    vehicle-skoda/
    meter-tibber-pulse/
  server/     — Express HTTP + SSE + MQTT bridge
  ui/         — React 19 + Vite admin app
plugins/      — third-party modules (auto-loaded at startup, gitignored)
docs/         — architecture, module authoring, config reference
```

### The four module types

| Interface | File | What it provides |
|---|---|---|
| `ChargerModule` / `Charger` | `src/sdk/charger.ts` | Hardware control (`setCurrentLimit`, `onStatus`) |
| `TariffModule` / `Tariff` | `src/sdk/tariff.ts` | 15-min price slots (`prices(from, to)`) |
| `BalancerModule` / `Balancer` | `src/sdk/balancer.ts` | Per-tick current allocation (`tick(input)`) |
| `VehicleModule` / `Vehicle` | `src/sdk/vehicle.ts` | SoC/range/target/plug/climate, on demand (`refresh()`); no timer — the lifecycle drives polling |

All module factories receive a `ModuleCtx` (from `src/sdk/index.ts`) that gives them access to the logger, SQLite, and the internal event bus. **Modules must not import from `src/core/` directly — only from `src/sdk/`.**

### Loadpoint (core concept, not a module)

A **loadpoint** (`src/core/loadpoint.ts`) is the control unit:
- It wraps a `Charger` instance and holds: mode (`disabled`/`smart`/`fast`), vehicle/tariff/balancer name references, `targetSoc`, `targetTime`
- Mode persists in SQLite across restarts
- It is what the REST API, MQTT, and UI all expose and control

The Balancer reads loadpoint state; the Charger provides hardware execution. Neither knows about the other.

### Smart charging: resolvers, planner, control loop (core, not modules)

Smart charging is built from **pure resolver ladders** (`src/core/smart-charging/`). Each planner
input is produced by a resolver that *always* returns a usable value tagged with which rung it used,
so no code branches on "is dependency X degraded" — degradation lives inside each ladder:

- **Energy** (`energy.ts`): live/estimated SoC + `targetSoc` → fixed `targetKWh` → duty-cycle heuristic.
- **Price** (`price.ts`): live tariff → last-N-day average per hour-of-day → static "cheap 23–05" curve.
  Always a non-empty curve (night priced strictly cheaper than day — equal prices would charge ASAP).
- **Current** (`current.ts`): live meter headroom (n=1 `allocate()`) → historical worst-case per hour →
  time-of-day static (`mainBreakerA − nightMargin` at night, `× daytimeFraction` by day). Clamped to
  `maxA`, floored `<6 A ⇒ 0`.

`src/core/planner.ts` turns `{requiredKWh, priceCurve, planRateA, targetTime}` into a 15-min schedule
(cheapest slots; or latest-start when there are genuinely no prices). `src/core/estimator.ts` derives
`estimatedSoc = lastKnownSoc + sessionKWh×η/capacity` (capacity cached per-VIN — one read enables
planning indefinitely).

`src/core/control-loop.ts` + the tick in `lifecycle.ts` drive it: ONE damped tick (default 30 s, since
a charger/car takes 15–30 s to react) resolves every loadpoint and commands its charger through a
deadband. Loadpoints group into **circuits** — those sharing a balancer coordinate through `allocate()`;
a balancer-less loadpoint is its own circuit and takes the resolved current budget directly. **Smart mode
therefore works with or without a balancer.** Wall-clock reasoning (night window, price hour-of-day) uses
Europe/Stockholm via `src/sdk/stockholm-time.ts`.

### Modules vs. the lifecycle: who owns what

This is the single most important boundary in the codebase. Get it right and everything stays lean.

**Modules are minimal mappers** to exactly one external service. A module does four things and nothing
more: authenticate, translate that service's data ⇄ OSC's SDK types *when asked*, actuate when told,
and report its own `health()`/degradation. A module owns **no orchestration** — no background timers,
no polling cadence, no decisions about *when* it runs or how its data combines with other modules'.
`charger-ocpp16`, `tariff-elprisetjustnu`, `tariff-elering`, `vehicle-skoda`, `meter-tibber-pulse`,
and `balancer-mqtt-circuit` all follow this: each is a thin translation layer over one protocol/API.

**The lifecycle owns orchestration** (`src/core/lifecycle.ts` + the pure helpers in
`src/core/smart-charging/`): the control-loop tick, *when* to poll a vehicle, the resolver ladders,
mode/target transitions — and, in 0.3.0, car identification and **car↔charger association** (which is
*runtime state*, not static config; see the 0.2.0 vision).

Worked examples:

- **Vehicle polling.** The module exposes `refresh()` — *one* live fetch on demand, no timer. The
  lifecycle decides *when*, via the pure `shouldPollVehicle()` gate (`smart-charging/vehicle-poll.ts`):
  on charger-connect + at most every `vehiclePollIntervalSec` while charging, **never while idle**
  (polling a parked car can wake and drain it, and risks an account lockout). The "don't poll a
  sleeping car" policy is orchestration, so it lives in the lifecycle — not smeared across the module.
- **Balancing.** The balancer is pure per-tick allocation math (`allocate(input)`); it does not own a
  loop. The lifecycle's single control tick drives it. Same split: the module computes, the lifecycle
  decides when and how it composes.

When you're tempted to add a `setInterval`, a "poll every N seconds", or cross-module coordination to a
module — stop. That belongs in the lifecycle. The module should just expose a pure "do it now" method.

---

## Degradation model (core design constraint)

The system is split into two tiers:

**Tier 1 (LAN-only, always works):** OCPP server, MQTT broker, balancer circuit math, SQLite, web UI.

**Tier 2 (internet-enhanced):** Tariff (Elering), Vehicle (Skoda API).

Every module reports `health(): 'ok' | 'degraded' | 'unavailable'`. The control loop *always* commands
a safe current via the resolver ladders — the top rung uses the best data; each lower rung degrades
independently (no combinatorial branching):
1. Live meter + live tariff + SoC → full optimization
2. Stale tariff → last-N-day average, then a static night-cheap curve
3. No meter/balancer → time-of-day static current (night `mainBreakerA − margin`, day `× fraction`)
4. No vehicle → fixed `targetKWh`, else a duty-cycle heuristic
5. Never exceed `maxA` / `mainBreakerA`; a sub-6 A budget resolves to 0 (never rounded up)

**Critical rule:** No internet-dependent code path may sit between a charger and a safe current limit.
Degraded modules must return their best available stale data, not throw. Smart mode requires neither a
balancer, a tariff, nor a vehicle — each is an enhancement, not a prerequisite.

---

## Config schema

```yaml
tariffs:    [{name, type: elering|elprisetjustnu, zone, ...}]   # elprisetjustnu = SE1–SE4; elering = EE/FI/LV/LT
balancers:  [{name, type, mainBreakerA, phases, meterTopicPrefix, safeStaticCurrentA, meterStaleAfterSec}]
vehicles:   [{name, type, ...}]
chargers:   [{name, type, stationId, maxA, phases}]
loadpoints: [{name, charger, vehicle?, tariff?, balancer?, defaultMode, targetSoc?, targetTime?, targetKWh?}]
mqtt:       {host, port, topicPrefix, homeAssistantDiscovery}
site:       {name, port, mainBreakerA?}                          # mainBreakerA = fallback fuse for balancer-less loadpoints
smartCharging: {controlIntervalSec, deadbandA, nightWindow, nightMarginA, daytimeFraction, historicalDays, vehiclePollIntervalSec, chargingEfficiency}
```

Name references enable multiplicity: multiple tariff zones, circuits, and chargers are just more list entries — no code changes required.

---

## MQTT topics

State (retained, published by OSC):
- `osc/loadpoints/<name>/mode`
- `osc/loadpoints/<name>/state` (JSON)
- `osc/loadpoints/<name>/current_a`
- `osc/tariffs/<name>/now`
- `osc/health/<module>`

Commands (not retained, subscribed by OSC):
- `osc/loadpoints/<name>/cmd/mode`
- `osc/loadpoints/<name>/cmd/target`

HA discovery: `homeassistant/select/<lp>_mode/config` etc.

---

## What NOT to do

- Do not add features, optimizations, or abstractions beyond what a specific task requires.
- Do not add comments describing *what* code does — only *why*.
- Do not make modules import from `src/core/` — they get everything they need via `ModuleCtx` from `src/sdk/`.
- Do not add error handling for impossible scenarios. Validate at system boundaries (config load, API calls), not internally.
- Do not use classes in TypeScript. Use functions and plain objects.
- Do not add caches unless the task explicitly requires them.
- Do not push to remote without explicit user request.
- Do not assume the internet is available — all code paths must handle its absence gracefully.

---

## Debugging OCPP chargers

Real chargers have quirks that cost real time. Before deep-diving a "charger won't charge" issue, read **`docs/ocpp-smart-charging.md`**. Key conventions:
- **`SetChargingProfile` returning `Accepted` ≠ applied.** Chargers stack profiles (highest `stackLevel` wins) and persist them across central-system reconnects, so a leftover profile (even from another CS) can override yours. Verify the *effective* limit with **`GetCompositeSchedule`** — make it your first diagnostic when `Current.Offered: 0` / `SuspendedEVSE`.
- **Read the charger's native/box-level OCPP docs**, not the cloud ones — reported capabilities (max stack level, units, supported commands) differ.
- Enable raw OCPP frame logging early when bringing up new hardware.

---

## Running the project

```bash
npm install           # install dependencies
npm run dev           # start with tsx (development)
npm run typecheck     # check types (no emit)
npm run lint          # ESLint
npm run format        # Prettier
npm run build         # compile to dist/
```

Requires Node.js >= 22.5 (uses `node:sqlite` built-in).

To test with a real MQTT broker:
```bash
docker compose up mosquitto -d
```
