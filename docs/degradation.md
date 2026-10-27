# Degradation: the design

Why OSC keeps charging when something is missing, who owns what when it does, and the cases and
scenarios a change must still satisfy. This is the single home for the model: AGENTS.md carries the
short form for agents, the README a user-facing summary, and the `degradation-review` skill checks
changes against this document.

## The goal

OpenSmartCharge has one primary goal: **the car is charged to its target by the deadline, at the lowest
risk we can manage with the facts we have.** An uncharged car in the morning is the failure this design
optimises against. Fuses are the backstop that keeps a mistake from becoming a hazard; they are not the
goal, and a tripped fuse is a nuisance, not a catastrophe.

"Risk" in this document means the risk of missing that goal — being blind about the house load, the
price, the car, or which car is plugged in — weighed against the small costs of charging a little more
than needed, a little earlier than optimal, or a little slower than the circuit would allow. Electrical
safety is handled by margins and by the fuse; it is never a reason to stop charging.

## Degraded best effort, not fail open or fail closed

When a dependency is lost — the meter, the balancer, the car's API, tomorrow's prices, the internet —
the affected module goes degraded and the engine replans from what it still knows: a rolling tail of
recent days plus a larger safety margin, because it knows less.

We do not use fail-open or fail-closed thinking. OSC is not safety-critical, so a lost input never means
"stop charging" and never means "charge at full rate". It means "plan with less information and more
margin". Local dependencies (the meter broker on the LAN, the balancer module, a charger's WebSocket)
degrade the same way as remote ones; there are no tiers that "always work" — every dependency has a rung
below it.

Concretely, every input the engine needs is produced by a **resolver ladder** (`src/core/smart-charging/`)
that always returns a usable value, tagged with the rung that produced it. The top rung uses the best
data; each lower rung uses older or coarser data with a larger margin; the bottom rung is a static
assumption that still charges. Nothing branches on "is X degraded" — degradation lives inside each
ladder, and the control loop reads only the value.

## Who owns degradation: shared

**A module owns the degradation of its own data.** It keeps serving the last known value together with
its age; it reports its health honestly (`ok` / `degraded` / `unavailable` describes _its data_, never the
system); it owns retries and backoff only for a source it schedules itself (today: the Nord Pool
publish-window refetch); it declares its capabilities; and it never throws from a data getter — a getter
returns the cache, and health says how old it is.

**The lifecycle owns the degradation of decisions.** The resolver ladders, the margins per rung,
replanning when data returns, which car is plugged in, the vehicle poll cadence and its backoff, and the
priority among signals (minSoc, climate, price, target) all live in `src/core/lifecycle.ts` and the pure
helpers in `src/core/smart-charging/`.

A module contributes **facts** — a reading, its age, its health, its capabilities — through a typed SDK
seam. It never contributes a decision.

Why shared, and not one side:

| Owner                     | For                                                                                 | Against                                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lifecycle owns everything | All policy in one place, trivially testable                                         | The lifecycle must know what "stale" means for a DSMR frame (seconds), a day-ahead price file (a publish window) and a car API with an account lockout (failure counts) — a per-module switch grows inside the core                  |
| Each module owns its own  | Modules are self-contained                                                          | Decisions spread across modules and combine unpredictably; a module sees neither the circuit nor the deadline; a module can "fix" its data silently — the stale cache that reported `ok` for ten hours in July 2026 was exactly this |
| Shared (chosen)           | Each side degrades what it understands: the module its data, the lifecycle the plan | Needs a written contract (this document) and a check that changes keep to it (the `degradation-review` skill)                                                                                                                        |

## The engine is declarative: render and reconcile

Control is declarative and top-down, like React rendering or Kubernetes reconciliation. Every control
tick re-derives the desired state — amps per loadpoint — from the current facts: module readings with
their age and health, the config, the plans, the clock. The same facts always give the same result, so a
tick is idempotent and re-running it is safe; the engine is free to re-run until two consecutive runs
agree (today a tick requested while one is running is re-run once it finishes, never in parallel).

The tick is the only writer. It is guarded against races (single-flight per circuit with a rerun flag)
and against chatter (a deadband on the commanded amps, a hysteresis in the split, a soft-start on
resume), and nothing steers between ticks: a meter frame updates the UI and the load history, it does not
command the charger.

What this buys: a module can be torn down and rebuilt at any time (the reconcile seam does this on every
config write); a lost dependency needs no special recovery code path — the next tick simply lands on a
higher rung when the data is back; and the "why" of every decision is observable (`resolve.sources` on
each loadpoint names the rung each input came from).

The few things deliberately carried across ticks are latches, not decisions: the SoC anchor for the
session (a real reading plus the energy delivered at that moment), the session vehicle latch and the
sticky vehicle override, the Fast boost until unplug, the last commanded amps (for the deadband and the
credit-back), and the per-source failure counters that drive backoff.

## Facts, not decisions

Today's seams, and the fact each carries:

- `MeterReader.latest()` — the last frame with its `timestamp`; `health()` says whether it is fresh
  (`meterHealth`, the one staleness rule for meters).
- `Tariff.prices(from, to)` — slots from the module's own cache; `health()` is derived from how far the
  cache reaches past the publish window.
- `Vehicle.getData()` — the last cached reading with `fetchedAt`; `health()` from recent failures;
  `capabilities` says what the car can report (SoC, range, capacity, presence, climate, target SoC).
- `ChargerStatus` — connected / charging / `currentA` / meter values, plus the designed-but-unused
  `socPct` and `evId` fields (and the charger `capabilities` that announce them) for a charger that reads
  the car over the cable.

The general form of a fact: a value, when it was true, how healthy its source is, and what the source is
able to report at all. Consumers branch on capabilities, never on a module's `type`.

**The extension seam (described, not built).** Two future contributors the seams are shaped for:

- _A charger that identifies the car and reads SoC over the cable_ (OCPP 2.0 / ISO 15118). A hard EV id
  outranks the car's own presence claim in identification; the energy resolver already takes a plain
  reading (`EnergyReading`), so the source is swappable without touching the ladder.
- _A solar or battery module that reports "surplus now"_. That is a fact the lifecycle folds into the
  price ladder as "cheaper than any slot right now"; how it ranks against a plan deadline is the
  lifecycle's decision, not the module's.

The rule for adding one: a new fact gets a typed field on an existing seam (or a new module type when
nothing fits), with an age and a health, and the lifecycle decides its priority. No new SDK type is added
until a second contributor needs it.

## The three ladders, their margins, and the history tail

Rung names below are exactly what `resolve.sources` reports.

**Energy** — how many kWh still need to be added (`energy.ts`):

1. `soc-capacity` — estimated SoC + target SoC + battery capacity. The estimate is the session anchor
   (the first successful poll of this plug-in, re-anchored by every later poll) carried forward by the
   kWh delivered since, at the efficiency observed this session (else `chargingEfficiency`). Capacity is
   cached per VIN, so one read ever enables this rung.
2. `target-kwh` — a fixed kWh-to-add target (a `kwh` plan, or the ad-hoc `targetKWh`), session-relative so
   it converges and stops.
3. `duty-cycle` — no car information at all: assume about 40 % duty at the charger's rate over the window
   to the deadline.

**Price** — when it is cheap (`price.ts`):

1. `live-tariff` — the tariff module's cached day-ahead slots, when any cover the window.
2. `historical-avg` — a synthetic hourly curve: the average price per site-local hour of day over the last
   `historicalDays`, from the same cache.
3. `static-night` — a synthetic curve that is cheap inside `nightWindow` and expensive outside it.

The curve is always non-empty and the night is always strictly cheaper than the day, so the planner can
always pick the cheapest slots; equal prices would make it charge as soon as possible. A `fixed` tariff is
that case on purpose.

**Current** — how many amps the circuit may draw (`current.ts`):

1. `live-meter` — `mainBreakerA − reserveA − max(phase currents) + the circuit's own draw`, only while the
   meter reader's health is `ok`.
2. `historical-worstcase` — `mainBreakerA − reserveA − worst load this hour (last historicalDays) − 1 A`.
3. `static-tod` — night: `mainBreakerA − nightMarginA`; day: `mainBreakerA × daytimeFraction`.

Every result is clamped to the charger's `maxA` and floored: a budget below the 6 A IEC minimum becomes 0
(charging at 6 A when 5 A is the budget would exceed it). With no `mainBreakerA` configured at all, the
charger's `maxA` is the limit; that is the expected state of a dedicated circuit without a house meter,
not a degradation.

**The history-tail rule.** When live data is missing, the engine replans from the rolling tail of recent
days (`historicalDays`, default 3): for current, the worst household load seen in each hour of the day;
for price, the shape of the last days' prices per hour of the day — peaks recur at similar times, and
avoiding them is what matters; for energy, the last known SoC carried forward by delivered energy. Design
intent, not yet in code (see ROADMAP): slack before and after a load peak, because a water-borne heating
system does not start at an exact minute; a median rather than a mean per hour, so one spike does not
shape the curve; and a history kept per circuit rather than merged across meters.

**The margins rule.** Every degraded rung carries a larger margin than the live rung, because it knows
less: the live rung keeps `reserveA` below the fuse; the historical rung adds a further 1 A on top of the
worst case; the static rung uses `nightMarginA` and `daytimeFraction`, which are generous by default.
Margins are planning inputs, not reaction speed — a bigger margin, never a faster tick. The static rung
is the lowest rung, not a ceiling: a meter that comes back raises the budget on the next tick.

## The fuse rule

Plan under the fuse with a modest margin (`reserveA`), and with a larger margin when the current rung is
degraded. A brief transient over the fuse — a dishwasher starting between two 30-second ticks — is
tolerated: the next tick sees it and corrects, the resume after a pause soft-starts at half the target so
the car ramps gently, and the overshoot is logged (throttled) as a diagnostic, not acted on faster. Never
steer faster than the control interval; stability beats reactivity, so hysteresis, a deadband and
cooldowns replace twitchy control — a charger takes 15–30 s to act on a new limit, and chasing it
oscillates. A tripped fuse is a nuisance, not a catastrophe. Future idea, not now: when far over the
fuse, a short pause and then a slow ramp back up.

## Which car is plugged in

Identification is runtime state, recomputed every tick (`guest.ts`), with a stability-first ladder:

1. Exactly one configured car whose own API says it is plugged in — a **positive claim** — wins, even
   over a stale sticky override (which is then cleared: "auto-detected another vehicle").
2. The **sticky override** set by the user: Guest, a manual car, or a forced app car. It persists across
   unplugs.
3. **Auto fallback**: with a single configured car, trust it unless it positively reports unplugged; with
   several, keep the latched car of this session unless it positively left.
4. **Guest** — no car telemetry; the kWh target or the duty cycle plans the session, and the Guest default
   is "just charge" (no pause at target).

With several cars configured, identification is a positive claim: while the car APIs are live, that claim
stands. When identification is degraded — the APIs are down and no car can claim the plug — assume the
car that needs the most charge and plan for it: an over-charged car costs a little money, an uncharged one
costs the morning. Guest stays an explicit user choice. _(design — not yet in code, see ROADMAP; today the
latch holds, and otherwise Guest is assumed)_

**A car that has been away is not at its last known SoC.** Trust the last reading only if the car has
been plugged in since; otherwise deduct an assumed consumption for the time away — the car's own km-per-%
ratio at an assumed 70 km/h when range data exists, else about 5 %-points per hour — capped at empty, and
tag the estimate degraded. _(design — not yet in code, see ROADMAP; today a car with no successful poll
this plug-in plans on the kWh target or the duty cycle, never on the old reading)_

Polling is lifecycle-owned and demand-driven: on charger-connect, then on the drawing / idle cadences
while plugged in, never while unplugged (a parked car can be woken and drained, and an account can be
locked). A failed poll backs off 30 s → 5 min and the last cached reading keeps serving.

## The only legitimate 0 A cases

A loadpoint is commanded 0 A only when:

1. **Mode is Off** (`disabled`).
2. **The resolved budget is below the 6 A IEC minimum** — the share is floored to 0 rather than rounded
   up ("throttle to 6 A and hold" is a known follow-up).
3. **The target is reached.** The energy resolver says nothing is left to add: smart mode then has nothing
   to plan, and fast mode pauses too when the governing plan's `pauseOnTarget` is on (the Guest default
   keeps it charging).
4. **The planner is waiting for a cheaper slot** — an explicit price pause; the car is on or ahead of its
   plan.

The `minSoc` floor and an active climate/preconditioning override cases 3 and 4 (climate alone at just
the 6 A minimum).

Any other 0 A — a missing balancer, a missing meter, a failed module, a lost connection, an unknown car —
is a bug against this design.

## Case matrix

Rows are dependencies; columns are the states a dependency can be in. Each cell says what the engine
does and what health and the API show. "Boot-failed" covers a module whose factory threw at startup.

### Charger (OCPP)

| State                                 | Engine                                                                                                                                                                      | Health / API                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live                                  | Commands through the deadband; soft-start on resume; the SessionReconciler recovers a latched car on the 30 s cadence                                                       | `ok`                                                                                                                                                                                           |
| Degraded (WebSocket blip, host sleep) | The charger keeps charging on its last profile; on reconnect OSC re-asserts the last commanded limit and rehydrates the open transaction from SQLite; a Fast boost survives | `degraded` while some claimed chargers are disconnected, `unavailable` when none is — one value for the whole OCPP server today (follow-up: per charger); the charger-offline banner in the UI |
| Boot-failed / unreachable             | Nothing to command on that charger; every other circuit continues                                                                                                           | `unavailable`                                                                                                                                                                                  |
| Not configured                        | A station that connects without a config entry is listed as pending for the claim flow; nothing charges on it until it is claimed                                           | `GET /api/chargers/pending`                                                                                                                                                                    |

### Meter reader

| State                                                                       | Engine                                                                                                                                                                                                             | Health / API                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Live                                                                        | `live-meter`                                                                                                                                                                                                       | `ok`; `GET /api/meters/:name` |
| Degraded (stale past `staleAfterSec`: broker down, bridge stopped)          | `latest()` keeps serving the last frame with its timestamp, but it is not used as live: the circuit lands on `historical-worstcase` for this hour when there is history, else `static-tod` — both with more margin | `degraded`                    |
| Boot-failed (no `broker:`, unreachable broker) / unavailable (no frame yet) | Same as degraded; load history from earlier days still feeds the historical rung                                                                                                                                   | `unavailable`                 |
| Not configured                                                              | A blind circuit: `static-tod` is its _normal_ state, not a fault. With no fuse configured either, the charger's `maxA` is the limit                                                                                | no entry                      |

A balancer names its reader; without a name, a circuit uses the sole configured reader automatically and
degrades when there are several (ambiguous).

### Balancer

| State                                              | Engine                                                                                                                                                                                                                                                           | Health / API                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Live                                               | Splits the resolved circuit budget: fast loadpoints first (declaration order), then an equal split among the smart loadpoints that want current; a 1 A hysteresis only ever holds a lower value; a share below 6 A floors to 0                                   | `ok`; `GET /api/balancers/:name` shows the last allocations                            |
| Degraded                                           | Not applicable — the balancer holds no data of its own; its meter degrades through the current ladder above                                                                                                                                                      | —                                                                                      |
| Boot-failed / unavailable / no module for its type | The balancer is not a prerequisite for charging: the lifecycle applies the same split itself — fast first, then an equal split, 6 A floor — on the resolved circuit budget, says so in `resolve` and in the log, and hands back to the module once it is rebuilt | `unavailable` when its factory threw (an unregistered type is only logged — follow-up) |
| Not configured                                     | A bare circuit on `site.mainBreakerA` through the same current ladder                                                                                                                                                                                            | no entry                                                                               |

### Tariff

| State                                                        | Engine                                                                                                                                                                                                                                                                               | Health / API                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Live                                                         | `live-tariff`; the shared Nord Pool schedule fetches at 13:15 market time plus a 0–120 s offset and retries failures at 10 → 20 → 40 → 60 min                                                                                                                                        | `ok`                                                              |
| Degraded (past 13:15 without tomorrow)                       | Cached slots still cover the rest of today; slots past the end of the cache are treated as the most expensive, so the planner uses them only if the known slots cannot cover the need _(design: back-fill the gap toward the deadline from the lower rungs, per slot — see ROADMAP)_ | `degraded`                                                        |
| Unavailable (no future slot cached, wrong zone, boot-failed) | `historical-avg` from whatever the cache holds, else `static-night` — charging happens in the night window. A `ZoneNotFoundError` is permanent: logged, and the schedule stops until the tariff is edited (which rebuilds the module), refreshed by hand, or OSC restarts            | `unavailable`; `POST /api/tariffs/:name/refresh` forces one fetch |
| Not configured                                               | `static-night`; nothing is wrong                                                                                                                                                                                                                                                     | no entry                                                          |

A `fixed` tariff prices every slot the same, so smart mode charges as early as possible — on purpose.

### Vehicle

| State                                                                                             | Engine                                                                                                                                                                                                                                       | Health / API                    |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Live                                                                                              | `soc-capacity` from the session anchor; a positive plug claim identifies the car; polls on the drawing / idle cadences                                                                                                                       | `ok`; `GET /api/vehicles/:name` |
| Degraded (1–2 failed polls, a cached reading exists)                                              | An anchor from an earlier poll this plug-in keeps the estimate accurate; without one the loadpoint plans on `target-kwh` or `duty-cycle` _(design: last known SoC minus the time away — see ROADMAP)_; polls retry with backoff 30 s → 5 min | `degraded`                      |
| Unavailable (3+ failures, dead auth after the 3-strike lockout, nothing ever cached, boot-failed) | `target-kwh` / `duty-cycle`; a single configured car is still trusted as present; with several and no claim, the latch holds, else Guest _(design: assume the car that needs the most — see ROADMAP)_                                        | `unavailable`                   |
| Not configured, or a `manual` car                                                                 | Guest or the manual car: a kWh target is a planning estimate, never polled, never auto-identified                                                                                                                                            | no entry / `ok`                 |

### Internet

There is no "internet" module; each module reports its own state, and the engine sees only rungs.

| State        | Engine                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Down         | The tariff and the vehicle degrade as above; the charger, the meter and the balancer are unaffected. The same tick runs on lower rungs with more margin |
| Down at boot | Boot does not wait for the network: the first price fetch is not awaited, the vehicle cache is warm from SQLite, and the OCPP server listens            |
| Back         | The next retry, poll or frame moves each ladder back up; the next tick re-plans — no restart, no manual step                                            |

A LAN-only installation is simply "not configured" for tariff and vehicle.

### Config

| State                                     | What happens                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid                                     | Schema defaults ⊕ the database store; `osc.yaml` is imported once                                                                                                   |
| One module rejects its config at boot     | That module is logged, skipped and shown `unavailable` (for example a meter reader without `broker:`); everything else boots and the ladders degrade around the gap |
| Invalid write via the API                 | Rejected with a 400 before anything is persisted, so a bad value can never brick the next boot; an imported document is validated whole, before any write           |
| `osc.yaml` fails the schema on first boot | Boot stops with the validation error; nothing is stored, so fixing the file and starting again is enough                                                            |
| Fresh database, no `osc.yaml`             | Onboarding in the UI; the OCPP server already listens, so a charger can be claimed                                                                                  |

### Two cases spelled out

**No balancer, no meter — a manual cap.** `site.mainBreakerA: 16`, `nightWindow` 22–06, `nightMarginA: 3`,
`daytimeFraction: 0.5`: the loadpoint runs on `static-tod` at 13 A between 22:00 and 06:00 and 8 A
otherwise, clamped to the charger's `maxA`. This is the lowest rung, not a ceiling: add a meter reader
later and the live rung takes over without any other change.

**Balancer configured but missing.** Two chargers on a 25 A circuit, meter live at 7 A: the budget is
25 − 1 − 7 = 17 A. With the balancer module gone the lifecycle splits it the same way the module would —
8 A + 8 A, a Fast loadpoint served first, nothing below 6 A — and `resolve` says the split is the
lifecycle's fallback.

## Scenarios

Each scenario: the situation, the facts the engine has, the rung each ladder lands on, the behaviour
over the night, what the user sees, what must not happen, and how to verify it.

### 1. Internet down from lunch, all night

Meter on the LAN, a Škoda, `elprisetjustnu`, plan "07:00 at 80 %". The uplink dies at 12:00, before
tomorrow's prices were published.

- Facts: today's prices until midnight in the cache; the car's last reading from the morning; live meter
  frames.
- Rungs: price `live-tariff` for the rest of today (slots after midnight count as most expensive), then
  `historical-avg` once no future slot is cached; energy `target-kwh` or `duty-cycle` if the connect poll
  fails (the morning reading is not re-anchored), `soc-capacity` as soon as a poll succeeds; current
  `live-meter` throughout.
- Over the night: charges the cheapest known slots at the live budget; on restore the next retry
  (10 → 20 → 40 → 60 min) refetches, the next poll re-anchors SoC, and the plan is re-cut.
- The user sees: tariff `degraded` then `unavailable`, vehicle `degraded`, the "why" badge naming the
  rungs.
- Must not: give 0 A because prices are missing; poll the unplugged car; need a restart.
- Verify: `price.test.ts`; `GET /api/loadpoints` → `resolve.sources`; pull the uplink and watch
  `GET /api/health`; `POST /api/tariffs/<name>/refresh` on restore.

### 2. The meter broker is down on the LAN, internet is up

- Facts: the last frame is older than `staleAfterSec`; three days of load history; live prices; a live
  car.
- Rungs: energy `soc-capacity`, price `live-tariff`, current `historical-worstcase` — on a 25 A fuse with a
  worst load of 9 A in this hour, 25 − 1 − 9 − 1 = 14 A.
- Over the night: the same cheap slots at 14 A instead of 16 A.
- The user sees: meter `degraded`, current rung `historical-worstcase`.
- Must not: give 0 A; use the stale frame as if it were live; steer per frame when the broker returns.
- Verify: stop the broker (or `npm run sim:pulse`) and watch `GET /api/meters/<name>` flip after
  `staleAfterSec`; `current.test.ts`.

### 3. No balancer, no meter — a manual cap

A single charger, `site.mainBreakerA: 16`, night window 22–06, defaults otherwise.

- Rungs: current `static-tod` — 13 A at night, 8 A by day; price and energy as configured.
- Must not: exceed 13 / 8 A; claim "balancing" in the UI; report `degraded` for a setup that is complete
  as configured _(follow-up)_.
- Verify: `resolve.budgetA` at 23:00 and at 12:00; move `nightWindow` with `PUT /api/smartcharging` and
  watch the budget follow.

### 4. The car comes back after a day away, API down

Cached SoC 78 % from 35 hours ago; the car is plugged in at 18:30; every poll fails (403 / 500) with
backoff.

- Today: no anchor this plug-in, so `duty-cycle` (about 40 % × 11 kW × 12.5 h ≈ 55 kWh asked for) or
  `target-kwh` if a kWh target governs; the car stops itself when full.
- Design: start from 78 % minus about 5 %-points per hour away, capped at empty, tagged degraded;
  re-anchor on the first successful poll.
- Over the night: charges a lot in the cheap hours; stops when the car stops or when a poll re-anchors
  the estimate.
- Must not: trust 78 % and add 2 %; poll while unplugged; give 0 A because the car is unknown.
- Verify: `energy.test.ts`, `estimator.test.ts`. Manually only by blocking the MySkoda hosts — never with
  a wrong password (the 3-strike lockout is real).

### 5. Two cars, both APIs down

- Today: no positive claim and no latch → Guest: a kWh target or the duty cycle, pause-on-target off.
- Design: assume the car that needs the most charge; a later claim takes over.
- Must not: give 0 A because identity is unknown; let a stale sticky override of the other car linger
  once a claim arrives.
- Verify: `guest.test.ts`; `activeVehicle` on `GET /api/loadpoints`.

### 6. The balancer is configured but missing

Two chargers on `house-main` (25 A), meter live at 7 A, the balancer's type has no registered module.

- Rungs: current `live-meter` → budget 17 A; the split is the lifecycle's fallback: 8 A + 8 A, a Fast
  loadpoint first, 6 A floor.
- The user sees: the balancer missing from health or `unavailable`, `resolve` naming the fallback split.
- Must not: give 0 A; hand each charger the whole 17 A; stay silent.
- Verify: the boot recipe in the `degradation-review` skill with `type: nope`; `GET /api/health`;
  `GET /api/loadpoints` → `resolve`; `npm run sim:charger` prints the commanded limit; `allocator.test.ts`.

### 7. A wrong tariff zone

`zone: SE5`, or Elering with `SE4`.

- Rungs: the fetch throws `ZoneNotFoundError`; with an empty cache the price ladder lands on
  `static-night`.
- Over the night: charges in the night window.
- The user sees: tariff `unavailable`, the error in the log.
- Must not: give 0 A; retry in a storm.
- Verify: `nordpool-tariff.test.ts`; boot with the bad zone and read `GET /api/health`.

### 8. Everything comes back at 02:30

- The next tariff retry, vehicle poll and meter frame move each ladder back to its top rung; the next
  tick re-plans on real prices and the live budget, with a soft-start on the first resume; the SoC
  estimate re-anchors on the first successful poll.
- Must not: require a restart; double-count delivered kWh across the re-anchor; jump to a high limit in
  one step.
- Verify: `curl -N localhost:8080/events` shows `health.changed`, `loadpoint.resolve` and `vehicle.poll`.

### 9. A load spike between two ticks

16 A fuse, the charger at 10 A, a tumble dryer adds 8 A on phase 2 → 18 A for up to 30 s.

- Next tick: `live-meter` = 16 − 1 − 18 + 10 = 7 A → the charger is set to 7 A; a warning names the
  overshoot (throttled to one per 5 min per circuit).
- The fuse tolerates 2 A over for 30 s; the correction is one tick, not a per-frame reaction.
- Must not: steer per meter frame; give 0 A; oscillate between 7 and 10 A (the deadband and the
  hysteresis hold).
- Verify: `control-loop.test.ts`; replay frames with `npm run sim:pulse` and watch the commanded limits
  in the simulated charger.

## Where the code lags this design

Each gap is tagged "(design — not yet in code)" above and tracked in ROADMAP.md under "Degradation
follow-ups (code)":

- A car's SoC after time away is not deducted; a car with no poll this plug-in plans on the kWh target or
  the duty cycle.
- With several cars and no claim, the engine assumes Guest rather than the car that needs the most.
- The historical current rung uses a plain hourly max with no slack around the hour, includes the
  circuit's own draw, merges all meters, and adds a hard-coded 1 A; the historical price rung is a mean,
  not a median.
- A partially covered price window is not back-filled from the lower rungs per slot.
- A loadpoint on `static-tod` because it has no meter on purpose still reports `degraded`.
- A module skipped at boot (factory threw, or no module registered for its type) is not retried and, for
  an unregistered type, has no health entry.

## Reviewing a change

Before reporting done on a change to a module (`src/modules`, `src/sdk`), a resolver
(`src/core/smart-charging`), the control loop or the lifecycle, or this document, run
`/degradation-review` — the `degradation-reviewer` subagent reads the diff, walks the case matrix for
every dependency the change touches, traces the affected scenarios, verifies with vitest and a boot with
the dependency deliberately missing, and reports a verdict. Act on its findings; a gap already listed
above is not a finding unless the change moves further away from the design.
