---
name: degradation-review
description: Reviews a change to OpenSmartCharge against the degraded-best-effort design in docs/degradation.md. For every dependency the change touches (charger, meter, balancer, tariff, vehicle, config), it checks the live / degraded / unavailable / not-configured states, honest health, facts-not-decisions, and that 0 A only occurs in the four legitimate cases, then verifies with vitest and a boot with the dependency deliberately missing. Produces a report with a PASS / CHANGES REQUIRED verdict.
when_to_use: Before reporting done on a change under src/modules, src/sdk, src/core/smart-charging, src/core/control-loop.ts, src/core/lifecycle.ts or docs/degradation.md; when someone asks whether a change degrades gracefully, keeps charging when something is missing, or handles a module being down; or when /degradation-review is invoked.
argument-hint: "[branch | PR | path | 'working tree']"
---

# Degradation review

OpenSmartCharge has one goal: the car is charged to its target by the deadline, at the lowest risk the available facts allow. A lost dependency degrades the module that owns it and lands the engine on a lower rung with more margin; it never stops charging. This review checks that a change keeps that promise. `docs/degradation.md` is the specification; this skill is the procedure.

## Who runs it

The author of the change delegates to the `degradation-reviewer` subagent (read-only tools, this skill preloaded), gives it the diff base, and acts on the report. If you are that subagent, continue below.

## Procedure

1. **Read the diff.** Default base `origin/main`: `git diff origin/main...HEAD`, plus `git diff HEAD` for uncommitted work, or the base you were given. List the files.
2. **Read the specification.** In `docs/degradation.md`: "The only legitimate 0 A cases", "Case matrix", "Scenarios", "Where the code lags this design". For a module change, also "Degradation: what a module owns" in `docs/modules.md`.
3. **Name the matrix rows the change touches.** A module change touches its own row; a resolver, control-loop or lifecycle change touches every row whose data flows through the changed code; a change to the design document touches the rows it rewrites.
4. **Walk each row's states** — live, degraded, unavailable or boot-failed, not configured — through the code as it is after the change. Write one line per cell: what the engine commands, what `health()` reports, what `resolve.sources` names.
5. **Apply the checklists** below.
6. **Trace the scenarios** the change affects and verify the ones a test or the boot recipe can prove.
7. **Report** in the format below.

## Checklist: the module side

Each line states what is true of a module that keeps to the contract.

- Live, degraded and unavailable each land on the documented rung of the ladder that consumes the module's data; a missing module leaves every loadpoint on a rung, not at 0 A.
- `health()` describes the module's own data: `ok` only for fresh data, `degraded` for stale data or after a failure, `unavailable` when there is nothing to serve. The SDK helpers (`meterHealth`, `sourceHealth`, `computeTariffHealth`) are the one way to derive it.
- The last known value is served together with its age (`timestamp`, `fetchedAt`), and a cache survives a rebuild because it lives in SQLite.
- Data getters return the cache (`latest()` → `null` before the first frame; `prices()` → what the cache holds; `getData()` → the cached reading). `refresh()` and `create()` are where a module throws.
- Retries and backoff exist only for a source the module schedules itself. The Nord Pool publish-window refetch in `src/sdk/nordpool-tariff.ts` is the one timer a module owns; a vehicle's cadence and backoff belong to the lifecycle.
- `capabilities` are declared, and consumers read them instead of the module `type`.
- The module contributes readings. Synthetic prices, a guessed household load, or a "charge now" / "stop" decision belong to the lifecycle's ladders.

## Checklist: the lifecycle and the resolvers

- Every tick re-derives the commanded amps from the current facts; the only state carried across ticks is a documented latch (the SoC anchor, the session vehicle latch and sticky override, the Fast boost, the last commanded amps, the per-source failure counters).
- The deadband, the single-flight guard with its rerun flag, the soft-start on resume and the allocator hysteresis are intact, and nothing steers faster than the control interval.
- A degraded rung keeps at least the margin the design gives it (`reserveA` on the live rung, a further 1 A on the historical rung, `nightMarginA` / `daytimeFraction` on the static rung), and no rung is removed or skipped.
- Every new or changed path to 0 A falls under one of the four legitimate cases: mode Off, a budget below the 6 A minimum, the target reached (fast mode only with the plan's `pauseOnTarget`), or a price pause.
- `resolve.sources` names the rung that produced each input, and a lifecycle fallback (for example the split applied when a balancer is missing) is visible there and in the log.
- Documentation the change has made untrue is listed (AGENTS.md, README.md, `docs/*.md`, CHANGELOG.md).

## The matrix and the scenarios

The case matrix and the nine scenarios live in `docs/degradation.md` and are read from there, never copied here: a reviewer who reads the living text also catches drift between the document and the code.

## Verification recipes

**Unit tests.** `npm test` runs everything (vitest). The ladders and their neighbours: `src/core/smart-charging/*.test.ts` (`current`, `price`, `energy`, `decide`, `guest`, `vehicle-poll`, `rollup`, `session-complete`), `src/core/control-loop.test.ts`, `src/core/estimator.test.ts`, `src/modules/balancer-mqtt-circuit/allocator.test.ts`, `src/sdk/nordpool-tariff.test.ts`, `src/sdk/source-reconciler.test.ts`. Run a single file with `npx vitest run <path>`.

**Boot with a dependency missing.** No broker, no network and no build are needed; everything runs from source in a scratch directory (`$SCRATCH` below is the session's scratchpad directory).

1. Write `$SCRATCH/degradation-boot/osc.yaml`. The dependency under review is deliberately missing — here a balancer whose type has no module; for a meter reader, drop its `broker:` block instead:

   ```yaml
   site: { name: 'degradation boot', port: 8091, mainBreakerA: 25 }
   chargers:
     - { name: sim, type: ocpp16, stationId: sim-01, maxA: 16 }
   balancers:
     - { name: house-main, type: nope, mainBreakerA: 25 }
   loadpoints:
     - { name: garage, charger: sim, balancer: house-main, defaultMode: fast }
   ```

   Fast mode makes the loadpoint want current regardless of price, so the commanded amps show the budget and the split directly.

2. Boot from a fresh data directory (the config is imported only once per database):

   ```bash
   rm -rf "$SCRATCH/degradation-boot/data"
   OSC_CONFIG="$SCRATCH/degradation-boot/osc.yaml" OSC_DATA_DIR="$SCRATCH/degradation-boot/data" \
     LOG_LEVEL=debug npx tsx src/core/lifecycle.ts > "$SCRATCH/degradation-boot/osc.log" 2>&1 &
   ```

   Wait until the log contains `HTTP server listening`.

3. Read the facts:

   ```bash
   curl -s localhost:8091/api/health
   curl -s localhost:8091/api/loadpoints | jq '.[] | {name, mode, connected, resolve}'
   grep -i -e 'balancer' -e 'circuit resolve' -e 'warn' "$SCRATCH/degradation-boot/osc.log" | head -40
   ```

   `resolve.sources` names the rung of each ladder and `resolve.budgetA` the circuit budget. A module whose factory threw shows as `unavailable` in `/api/health`; a module whose type has no registered module is absent from it and only logged.

4. When the commanded amps matter, connect the simulated charger and read what it is told. It boots, reports its connector `Available`, then `Preparing` two seconds later (a car plugged in), and prints every `SetChargingProfile` it receives (`[sim] SetChargingProfile → limit: N A`):

   ```bash
   node scripts/sim-charger.mjs --url ws://localhost:8091/ocpp --station-id sim-01
   ```

   A limit of 0 A outside the four legitimate cases is a Blocker.

5. Stop the processes you started (`kill %1 %2`, or by PID) and remove the scratch directory.

The same recipe covers the other rows: a meter reader without `broker:` (boot-failed meter → `historical-worstcase` or `static-tod`), a tariff with `zone: SE5` (→ `static-night`), a vehicle with an unreachable API (→ `target-kwh` / `duty-cycle`), or no balancer and no meter at all (→ `static-tod` against `site.mainBreakerA`).

## What counts as a finding

- **Blocker.** A path to 0 A outside the four legitimate cases. A data getter that throws. A decision (synthetic prices, guessed load, charge/stop) inside a module. A timer in a module other than the tariff schedule. `health()` reporting `ok` on stale or failed data. A rung removed or skipped. A smaller margin on a degraded rung. Steering faster than the control interval.
- **Major.** Landing on a lower rung when a higher one had data. Documentation the change made untrue. A `resolve` source that does not name the rung, or a lifecycle fallback that leaves no trace in `resolve` or the log.
- **Minor.** Wording, log text, a test that would have made a degraded state visible.
- **Not a finding.** A gap already listed under "Where the code lags this design" — unless the change moves further away from the design.

## Report

Markdown, verdict first.

- **Verdict:** PASS or CHANGES REQUIRED, in two sentences.
- **What ran:** the commands, their exit codes, and the boot evidence (health, `resolve`, the commanded limits).
- **Findings** by severity. Each names the file, the matrix cell (row and state), what happens, how it was verified, and the simplest fix that fits the design.
- **Docs the change made untrue.**
- One line when everything is clean.
