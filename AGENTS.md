# AGENTS.md — Guide for AI agents working on OpenSmartCharge

This file captures the decisions, principles, and conventions established for this codebase. Read it before making any changes.

## Project north star

OpenSmartCharge is a **lean, modular, LAN-survivable** EV smart-charging system. The goal is a codebase that a single developer can fully understand, run on a Raspberry Pi, and extend in 2 years without needing to re-learn how it works.

**Lean**: Every feature is justified. Ask "is there a simpler way?" before adding. No early optimization, no caches unless required, no abstractions for hypothetical future needs.

**Modular**: Features live in modules (`src/modules/`). The core (`src/core/`) handles orchestration only. Module interfaces live in `src/sdk/`. First-party modules are reference implementations — readable enough for a third party to copy and adapt.

**LAN-survivable (degraded best effort)**: the car is charged to its target by the deadline, at the lowest risk the available facts allow. A lost dependency — local or remote — lands on a lower rung with more margin; it never stops charging. See the degradation model below and `docs/degradation.md`.

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
10. **Run the tools** — after file edits, run `npm run format && npm run typecheck && npm run lint && npm test` and fix all errors before reporting done. (The root `lint`/`format`/`typecheck` scripts cover `src/ui2` too.)
11. **Sanity-check** — after completing a task, randomly pick one modified file and re-read it as a stranger would. State what you find.
12. **Degradation review** — a change to a module (`src/modules`, `src/sdk`), a resolver (`src/core/smart-charging`), the control loop or lifecycle, or `docs/degradation.md` is reported done only after `/degradation-review` (the `degradation-reviewer` subagent) has run and its findings are addressed.

---

## Architecture

### Directory layout

```
src/
  core/       — config, registry, plugin-loader, events, db, logger,
                loadpoint, planner, estimator, health, lifecycle
  sdk/        — TypeScript interfaces for the five module types + ModuleCtx, plus the shared
                helpers modules may import (local-time, broker, nordpool-tariff, electrical,
                source-reconciler)
  modules/    — first-party reference modules
    charger-ocpp16/
    tariff-elering/          (EE/FI/LV/LT)
    tariff-elprisetjustnu/   (SE1–SE4)
    tariff-fixed/            (flat rate, no network)
    balancer-mqtt-circuit/
    vehicle-skoda/
    vehicle-manual/          (no API — kWh-only targets, never polled)
    meter-tibber-pulse/
    meter-mqtt-phase/        (raw <prefix>/i{1,2,3}_a feed)
  server/     — Express HTTP + SSE + MQTT bridge
  ui2/        — React 19 + Vite (TanStack Start, built as a static SPA) admin app
plugins/      — third-party modules (auto-loaded at startup, gitignored)
docs/         — architecture, module authoring, config reference, degradation model
```

### The five module types

| Interface | File | What it provides |
|---|---|---|
| `ChargerModule` / `Charger` | `src/sdk/charger.ts` | Hardware control (`setCurrentLimit`, `onStatus`) |
| `TariffModule` / `Tariff` | `src/sdk/tariff.ts` | 15-min price slots (`prices(from, to)`) |
| `BalancerModule` / `Balancer` | `src/sdk/balancer.ts` | Per-tick current allocation (`tick(input)`) |
| `VehicleModule` / `Vehicle` | `src/sdk/vehicle.ts` | SoC/range/target/plug/climate, on demand (`refresh()`); no timer — the lifecycle drives polling |
| `MeterReaderModule` / `MeterReader` | `src/sdk/meter-reader.ts` | Live household current (`latest()`); its `health()` is the one staleness authority |

All module factories receive a `ModuleCtx` (from `src/sdk/types.ts`) that gives them access to the logger, SQLite, and the internal event bus. **Modules must not import from `src/core/` directly — only from `src/sdk/`.**

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
- **Current** (`current.ts`): live meter headroom → historical worst-case per hour →
  time-of-day static (`mainBreakerA − nightMargin` at night, `× daytimeFraction` by day). Clamped to
  `maxA`, floored `<6 A ⇒ 0`.

`src/core/planner.ts` turns `{requiredKWh, priceCurve, planRateA, targetTime}` into a 15-min schedule
(cheapest slots; or latest-start when there are genuinely no prices). `src/core/estimator.ts` derives
`estimatedSoc = lastKnownSoc + sessionKWh×η/capacity` (capacity cached per-VIN — one read enables
planning indefinitely).

`src/core/control-loop.ts` + the tick in `lifecycle.ts` drive it: ONE damped tick (default 30 s, since
a charger/car takes 15–30 s to react) resolves every loadpoint and commands its charger through a
deadband. Loadpoints group into **circuits** — those sharing a balancer coordinate through the balancer's `tick()`;
a balancer-less loadpoint is its own circuit and takes the resolved current budget directly. **Smart mode
therefore works with or without a balancer.** Wall-clock reasoning (night window, price hour-of-day, plan
ready-by) uses the configurable **site** timezone (`getTimezone(db)`, default Europe/Stockholm) through the
helpers in `src/sdk/local-time.ts`.

The design these ladders implement — the goal, who owns which part of degradation, the margins per rung,
the fuse rule and the only legitimate 0 A cases — is `docs/degradation.md`.

### Modules vs. the lifecycle: who owns what

This is the single most important boundary in the codebase. Get it right and everything stays lean.

**Modules are minimal mappers** to exactly one external service. A module does four things and nothing
more: authenticate, translate that service's data ⇄ OSC's SDK types *when asked*, actuate when told,
and report its own `health()`/degradation. Degradation itself is **shared**: the module degrades its *data*
(the last known value with its age, honest health, declared capabilities, no throwing getters); the
lifecycle degrades the *decisions* (the ladders, the margins, replanning, car identification). Modules
contribute facts, never decisions. A module owns **no orchestration** — no background timers,
no polling cadence, no decisions about *when* it runs or how its data combines with other modules'.
`charger-ocpp16`, `tariff-elprisetjustnu`, `tariff-elering`, `vehicle-skoda`, `meter-tibber-pulse`,
and `meter-mqtt-phase` all follow this: each is a thin translation layer over one protocol/API.
(`balancer-mqtt-circuit` is the boundary's limiting case — it maps *no* external service at all; it's
pure allocation math with no meter and no timer. See Balancing below.) The one deliberate timer
exception: Nord Pool prices publish at a fixed market time, and that publish-window refetch (plus its
retry backoff and a random herd-spreading offset) lives in the **shared** `src/sdk/nordpool-tariff.ts`
factory — a provider module is just its `fetchSlots` function.

**The lifecycle owns orchestration** (`src/core/lifecycle.ts` + the pure helpers in
`src/core/smart-charging/`): the control-loop tick, *when* to poll a vehicle, the resolver ladders,
the smart-mode force signals (`minSoc` floor + climate/preconditioning → force-charge, overriding
price and a reached target — climate at just the 6 A IEC minimum), the SessionReconciler
(`core/session-reconciler.ts`: level-triggered recovery when a car wants charge but a latched open session
draws ~0 A — some VW-group cars won't resume on a limit change alone), mode/target
transitions — and, in 0.3.0, car identification and **car↔charger association** (which is
*runtime state*, not static config; see the 0.2.0 vision).

Worked examples:

- **Vehicle polling.** The module exposes `refresh()` — *one* live fetch on demand, no timer. The
  lifecycle decides *when*, via the pure `shouldPollVehicle()` gate (`smart-charging/vehicle-poll.ts`):
  on charger-connect, then `vehiclePollIntervalSec` while actively drawing (+ night idle) and the
  faster `vehicleIdlePollIntervalSec` while connected-but-idle in the daytime window; **never while
  unplugged** (polling a parked car can wake and drain it, and risks an account lockout). The "don't
  poll a sleeping car" policy is orchestration, so it lives in the lifecycle — not in the module.
- **Balancing.** The balancer is pure per-tick allocation math (`tick({loadpoints, circuitBudgetA})`);
  it holds no meter, no timer, no staleness. The lifecycle resolves the circuit's current budget **once**
  per tick — the meter reader is the SSoT for live current *and* its staleness (`health()`), and the
  `resolveCurrentBudget` ladder degrades it (live-meter → historical → static-tod) — then hands the
  balancer a single number to split across the circuit's loadpoints. The module computes the split; the
  lifecycle decides the budget and when it composes.

When you're tempted to add a `setInterval`, a "poll every N seconds", or cross-module coordination to a
module — stop. That belongs in the lifecycle. The module should just expose a pure "do it now" method.

### Declarative config & soft-reload (modules must survive a reboot)

OSC is **declarative**: the effective config = schema defaults ⊕ the DB config store (`config_overrides`
+ `settings` + `loadpoint_state`) — see `core/config-overrides.ts`. `osc.yaml` is an *import format*: a
fresh database materializes it once (`core/config-io.ts`), after which the file is inert and the DB is
the source of truth (re-import with `npm run config:apply` or `POST /api/config/import`). The lifecycle
runs on that effective config; an API write (region, breaker, a claimed charger, an added vehicle)
persists an override, and the **reconcile seam** (`core/reconcile.ts`) applies it live: it mutates the in-memory
config in place *and* **rebuilds the affected module** from the new config, swaps it in the Map, and
re-wires listeners — no process restart.

That only works because **a module must survive being torn down and rebuilt at any time.** A module
holds *no* critical in-memory state:

- **Durable** state → SQLite (transactions, tariff slots, the vehicle refresh token + cache, loadpoint
  mode/targets/plans). Survives a rebuild for free.
- **Desired** state (the amps to command) → re-derived every control tick by the lifecycle. Never stored
  in the module.
- **Observed** state (connected / charging / SoC) → re-reported by the hardware/API on reconnect (OCPP
  Boot/StatusNotification; the vehicle's next poll). The charger even keeps charging on its last profile
  through a backend blip, and the open transaction is rehydrated from SQLite on reconnect.

This is the same property that makes **degradation and flaky connectivity** safe: a module that rebuilds
cleanly is one that can drop, reconnect, and re-sync without losing anything. So when you write or change
a module: **never park important state in a field a rebuild would lose** — push it to SQLite, re-derive
it each tick, or re-read it from the source on (re)connect. And reconcile builds + starts the new
instance *before* stopping the old, so an in-flight tick never sees a half-dead module.

---

## Degradation model (core design constraint)

The full model, the case matrix and the scenarios live in **`docs/degradation.md`**. The rules that must
survive any change:

- **Goal:** the car is charged to its target by the deadline at the lowest risk the facts allow. An
  uncharged car is the failure we optimise against; fuses are the backstop, not the goal.
- **Degraded best effort, not fail open or fail closed.** A lost dependency — meter, balancer, car API,
  prices, internet — degrades the affected module and the engine replans from the rolling tail of recent
  days with a larger margin. It never stops charging and never charges blind at full rate. Local and
  remote dependencies degrade the same way; there are no tiers that "always work".
- **Shared ownership.** A module degrades its own data (last known value with age, honest health,
  capabilities, retries only for a source it schedules itself, no throwing getters). The lifecycle
  degrades decisions (ladders, margins, replanning, identification, priority among signals). Modules
  contribute facts, never decisions.
- **Declarative tick.** Every tick re-derives amps per loadpoint from the current facts; same facts, same
  result; re-running is safe. Single-flight per circuit with a rerun flag, a deadband, and no steering
  between ticks.
- **Fuse rule.** Plan under the fuse with `reserveA`, more margin when degraded; a transient over the
  fuse between two ticks is corrected on the next tick, never by ticking faster.
- **0 A is legitimate only when:** mode is Off; the budget is below the 6 A minimum; the target is reached
  (fast mode only with the plan's `pauseOnTarget`); or the planner is waiting for a cheaper slot. Any
  other 0 A is a bug.

Before reporting done on a change to a module, a resolver, the control loop or lifecycle, or
`docs/degradation.md`, run **`/degradation-review`** (the `degradation-reviewer` subagent) and act on its
findings.

---

## Config schema

```yaml
tariffs:    [{name, type: elering|elprisetjustnu|fixed, zone|pricePerKWh, ...}]   # elprisetjustnu=SE1–SE4; elering=EE/FI/LV/LT; fixed=flat rate
balancers:  [{name, type, mainBreakerA, phases, meterReader?, nightMarginA?, daytimeFraction?, reserveA?}]  # pure splitter; meterReader → the live-current SSoT
meterReaders: [{name, type: tibber-pulse|mqtt-phase, broker: {host, port, user?, password?}, ...}]  # live household current + its staleness authority; each listens on its OWN broker
vehicles:   [{name, type: skoda|manual, ...}]
chargers:   [{name, type, stationId, maxA, phases}]
loadpoints: [{name, charger, vehicle?, tariff?, balancer?, defaultMode, autoRevertToSmart?, targetSoc?, targetTime?, targetKWh?, minSoc?}]
mqttBridge: {broker: {host, port, user?, password?}, topicPrefix, homeAssistantDiscovery}   # OSC's OUTBOUND publishing; optional
site:       {name, port, mainBreakerA?, timezone?}               # timezone: site/user tz (default Europe/Stockholm); mainBreakerA = fallback fuse
smartCharging: {controlIntervalSec, deadbandA, nightWindow, nightMarginA, daytimeFraction, reserveA, historicalDays, vehiclePollIntervalSec, vehicleIdlePollIntervalSec, vehicleIdlePollDayWindow, chargingEfficiency}
```

Name references enable multiplicity: multiple tariff zones, circuits, and chargers are just more list entries — no code changes required.

**Runtime state vs config.** Recurring charging **plans** (`charge_plans` table, `src/core/plans.ts`) and
**system settings** (`settings` table, `src/core/settings.ts` — e.g. the site timezone) are managed at
runtime via the UI/API, NOT `osc.yaml` — they're edited often. Config only *seeds* the ad-hoc loadpoint
target + defaults; `npm run config:apply` re-asserts config onto the DB. Two timezones, kept distinct in
`src/sdk/local-time.ts` (tz is always a param): the **site** tz (`getTimezone(db)`) drives planning
(night window, plan ready-by, targets); tariff providers pass their **market** tz (Nord Pool = CET) for
publish windows + per-day price files — that follows the price market, not the user.

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

HA discovery: `homeassistant/select/osc_<lp>_mode/config` etc. (device `OSC <lp>`).

---

## What NOT to do

- Do not add features, optimizations, or abstractions beyond what a specific task requires.
- Do not add comments describing *what* code does — only *why*.
- Do not make modules import from `src/core/` — they get everything they need via `ModuleCtx` from `src/sdk/`.
- Do not add error handling for impossible scenarios. Validate at system boundaries (config load, API calls), not internally.
- Do not use classes in TypeScript. Use functions and plain objects.
- Do not add caches unless the task explicitly requires them.
- Do not put timing inside a request primitive. Jitter, backoff and cadence are *scheduling* concerns and live where the schedule is decided — the lifecycle for vehicle polls, the shared Nord Pool factory for the publish-window refetch. Modules call the plain global `fetch` with a per-request `AbortSignal.timeout`. (A jittered `ctx.fetch` once existed; it silently broke every caller's timeout signal and was removed.)
- Do not push to remote without explicit user request.
- Do not assume any dependency is available. A lost meter, balancer, car API, price feed or internet link lands on a lower rung with more margin; it never resolves to 0 A outside the four legitimate cases (`docs/degradation.md`).

---

## Debugging OCPP chargers

Real chargers have quirks that cost real time. Before deep-diving a "charger won't charge" issue, read **`docs/ocpp-smart-charging.md`**. Key conventions:
- **`SetChargingProfile` returning `Accepted` ≠ applied.** Chargers stack profiles (highest `stackLevel` wins) and persist them across central-system reconnects, so a leftover profile (even from another CS) can override yours. Verify the *effective* limit with **`GetCompositeSchedule`** — make it your first diagnostic when `Current.Offered: 0` / `SuspendedEVSE`.
- **Read the charger's native/box-level OCPP docs**, not the cloud ones — reported capabilities (max stack level, units, supported commands) differ.
- Enable raw OCPP frame logging early when bringing up new hardware.

---

## Running the project

```bash
npm install                    # install dependencies
npm --prefix src/ui2 install   # the UI has its own package.json (lint/format/typecheck reach into it)
npm run dev                    # start with tsx (development)
npm run typecheck              # check types, backend + UI (no emit)
npm run lint                   # ESLint, backend + UI
npm run format                 # Prettier, backend + UI
npm test                       # vitest (backend)
npm run build                  # compile to dist/ (backend + the UI bundle)
```

Requires Node.js >= 22.5 (uses `node:sqlite` built-in).

To test with a real MQTT broker:
```bash
docker compose up mosquitto -d
```
