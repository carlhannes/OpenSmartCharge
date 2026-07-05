# OpenSmartCharge — Vision & Roadmap for v0.2.0

> This is a design brief + backend roadmap, not a UI spec. It captures the UX vision as user stories and maps the backend gaps needed to support a mobile-first redesign. The frontend is built separately from the user stories here.
>
> **Decisions locked:**
> 1. **SQLite is the single *live* source of truth for config; YAML is import/export only** (no dual source). Config splits by *nature*, which keeps single-source-of-truth clean because these are genuinely different kinds of data:
>    - **Topology** (chargers, meters, tariff/zone, balancer/breaker, vehicles, credentials) → stored as **one JSON config document** (single DB row) with a declarative `GET`/`PUT /api/config` surface, zod-validated.
>    - **Plans** (weekly schedules) → a normalized table (the resolver queries them).
>    - **Live mode + ad-hoc target** → stay in the existing `loadpoint_state` table (frequent, cheap writes).
>    - **Derived/historical** (transactions, meter samples, tariff & vehicle caches) → unchanged.
>    - `osc.yaml` is only read once (first-boot import) and written on export; `osc.dist.yaml` remains the commented human reference.
> 2. **Topology changes apply via a soft in-process reload.** `PUT /api/config` tears down and rebuilds the *whole* module graph in-process (a full rebuild, **not** hot-diffing) so onboarding flows straight into a working dashboard with no container restart. Plans and mode changes are always instant — they're read live each balancer tick, so they need no reload.
> 3. **Phased delivery:** 0.2.0 = redesign + onboarding + plans + km/% targets + durability; 0.3.0 = climate-triggered charging + automatic car detection (the fragile, Skoda-specific work).

---

## Context — why we're doing this

Today's UI (M5, shipped) is an honest but *engineer-shaped* dashboard: six top-nav tabs (Dashboard, Loadpoints, Tariffs, Balancers, Transactions, Health) that expose backend modules almost 1:1. It uses domain jargon on the primary surface ("loadpoint", "disabled", raw amps), supports exactly **one** charging target per charger (`targetSoc` + `targetTime`), and has **no setup flow at all** — the entire system is configured by hand-editing `osc.yaml` and restarting.

We want to redesign the app **mobile-first** around what the user is actually trying to do — *"make sure my car is cheaply charged and ready when I need it, without thinking about it"* — the way a senior designer at Apple/Spotify would: one clear job per screen, plain language, progressive disclosure, defaults that just work. That redesign needs backend capabilities that don't exist yet (a config write-path, recurring multi-plan schedules, km/kWh targets, charger pairing). This document captures the UX vision as user stories and then maps the backend gaps + roadmap to support it.

---

# PART 1 — Who the user is, and the jobs to be done

**Persona.** A self-hosting EV owner. Technical enough to run Docker on a Raspberry Pi, but their *daily* interaction is 10 seconds on a phone. They own one car (maybe two), one charger (maybe more later), care about charging on cheap/green hours, and above all want the car **ready when they leave**. They don't want to think about amps, OCPP profiles, or tariff slots.

**Jobs To Be Done (in priority order):**

1. **Get set up** — "Connect my charger, my house meter, my region and my car, and reach a working state without editing files." *(Today: impossible via UI.)*
2. **Glance & trust** — "Open the app and instantly know: is my car going to be ready, and what's it doing right now?" *(Today: possible but buried across tabs, in jargon.)*
3. **Set my intent** — "Be ready by 07:00 at 80% on weekdays, ready by 09:00 on weekends." *(Today: single one-off target only.)*
4. **Override when life happens** — "Just charge now" / "stop" / "give me 6 A". *(Today: exists, but as co-equal primary buttons.)*
5. **Trust it under failure** — "Tell me if something's degraded, but keep the car charging." *(Today: a Health tab of module states.)*

The redesign is ranked by these jobs: **#2 is the home screen, #3 is the one big new feature, #1 unblocks new users, #4/#5 are progressive-disclosure.**

---

# PART 2 — Design principles

- **One question per screen.** Home answers only: *"Will my car be ready, and what's it doing?"* Everything else is a tap away.
- **Plain language on the primary surface.** "Ready by 7:00 ✓", "Waiting for cheap power — starts 01:30", "Plugged in, paused." Never `targetSoc`, `latestStart`, or bare amps up front. Show **kW** (friendly) with amps available on drill-in.
- **Progressive disclosure.** Sensible defaults; advanced controls (one-shot amp limit, OCPP Reset, clear-profile, composite schedule) live behind an "Advanced" disclosure, not on the main card.
- **Direct manipulation.** Tap the charger → see its plan → change it inline. No separate "edit" mode.
- **Rename jargon in the UI (keep it in the API).** `loadpoint` → shown as **"charger"** (they're 1:1 today). Mode `disabled` → **"Off"**. Modes shown as **Off / Smart / Fast**.
- **Mobile-first ergonomics.** Thumb-reachable primary actions, big tap targets, bottom tab bar, one vertical scroll on Home; desktop is the same layout widened (detail opens as a side panel instead of a bottom sheet).
- **Status you can trust at a glance.** Consistent color language (green ok / amber degraded / red down / blue "active now"), always paired with a word.

---

# PART 3 — Information architecture (three concepts, one recommendation)

We collapse today's **6 tabs → 3**: **Home · History · Settings.** Tariffs, Balancers and Health stop being destinations and become *contextual* (price appears inside a plan; balancer headroom appears on Home only when it's actually limiting you; health appears as banners + a Settings→System page).

**Concept A — Single-scroll Home + detail sheets (RECOMMENDED spine).**
Bottom tab bar. Home = a hero status line + one card per charger. Tapping a card opens a detail sheet (bottom sheet on mobile / side panel on desktop). Simple, scales from 1 to a few chargers, minimal navigation depth.

**Concept B — Card wallet (swipeable charger cards).**
For users with 2–3 chargers: full-bleed, horizontally-swipeable charger cards (Apple-Wallet-like). *Recommendation: adopt this only as Home's presentation when there's >1 charger; a single charger shows one full card.*

**Concept C — Timeline-centric.**
Home is a 24h timeline: price curve + shaded "will-charge" blocks + a "ready-by" marker + a now-line. Very forecast-forward (EVCC-like) but cleaner. *Recommendation: this is the wrong hero for Home (too much for a glance), but it is exactly right as the hero of the **charger-detail** view.*

**Recommended synthesis:** **A** as the navigation spine, **B**'s swipe when there's more than one charger, **C**'s timeline inside charger-detail. Three tabs, sheets for depth, timeline where planning happens.

---

# PART 4 — User stories & screens (0.2.0)

### 4.1 Onboarding wizard (first-run, and re-runnable)

> **Story:** *As a new user, when I first open OSC, I'm guided step-by-step to a working charger — so I never have to hand-edit a YAML file.*
> **Story:** *As an existing user, I can re-run any step to add another charger, car, or plan later.*

Flow (each step skippable where sensible; progress persists):
1. **Welcome** — one line on what OSC does.
2. **Connect your charger** — show the exact `ws://<host>:8080/ocpp/<id>` URL with copy button and a live *"Waiting for your charger to connect…"* state that flips to **"✓ Detected `<stationId>`"** the moment a charger opens a WebSocket. This *is* the pairing moment — we surface the otherwise-orphaned unknown-station connection and let the user **claim** it (name it, confirm max amps).
3. **Electricity region** — pick zone (SE1–SE4, plus EE/LV/LT/FI) from a labelled list/map.
4. **House & load balancing** — enter main breaker size; optionally connect a Tibber Pulse / MQTT meter, with a clear *"Skip — use a safe static limit"* path (a blind circuit with no `meterReader`, running the static-tod fallback: night `mainBreakerA − nightMarginA`, day `× daytimeFraction`).
5. **Add your car** *(optional)* — Skoda login, or **"Skip — use a Guest profile."**
6. **First plan** — accept a sensible default (*Ready by 07:00, 80%, every day*) or customize. Done → land on Home.

*Design note:* the wizard is **not** one-time — "Add charger / car / plan" in Settings re-enters the relevant step.

### 4.2 Home / Overview

> **Story:** *As a daily user, I open the app and instantly know whether my car will be ready and what it's doing — without reading numbers.*

- **Hero status**, plain language per active charger: *"Charging · ready by 7:00 ✓"* / *"Waiting for cheap power · starts 01:30"* / *"Plugged in — paused"* / *"Nothing connected."*
- **Charger card:** name, big status, current **power (kW)**, a **progress ring** (current → target SoC), **mode segmented control (Off / Smart / Fast)**, and the **active plan summary** (*"Weekdays · ready 7:00 · 80%"*).
- **Car chip:** *"🚗 Enyaq"* when a car is associated, or *"Guest"* — tap to switch.
- **Constraint line** (only when relevant): *"Limited to 10 A — house using 12 kW."* (Balancer surfaced contextually.)
- **Degradation banner** (only when relevant, dismissible): *"Prices unavailable — using yesterday's. Charging continues."* (maps to module health.)

### 4.3 Charger detail (sheet / side panel)

> **Story:** *As a user, I tap my charger to see the plan and adjust it.*

- **Hero = the 24h timeline** (Concept C): price curve, shaded charge windows, now-line, ready-by marker.
- **Mode** segmented control.
- **Vehicle switcher:** Guest (default) vs known car. Known car → live SoC + range. Guest → only charger-metered kWh, with an optional manual target (kWh or "just charge").
- **Plans** list (see 4.4).
- **Advanced** disclosure: one-shot amp limit, Start/Stop, Reset (Soft/Hard), clear profile, composite-schedule diagnostic — today's OCPP command buttons, **demoted** from primary UI.

### 4.4 Plans (the flagship new feature)

> **Story:** *As a user, I want between zero and several plans per charger. Each plan lets me toggle which weekdays it's active, set a "ready by" time, and set a target as % **or** km.*

- **Plan card:** a day-of-week toggle row — **M T W T F S S** as pill toggles; a **"Ready by"** time picker; a **target with a % ⇄ km switch**; enable/disable; delete.
- **km target:** user sets e.g. *350 km*; UI shows *"≈ 78%"* derived live from the car's range/SoC ratio, with a note *"km targets need a connected car."* (Guest can use % or kWh only.)
- **Zero plans** = *"just charge when plugged in"* (or Off). One-tap **"Add plan."**
- **Resolution rule (state it explicitly in UI/help):** among plans whose active-days include today, the one with the **next upcoming "ready by"** governs; if two share a day, earliest ready-by wins.

### 4.5 History

> **Story:** *As a user, I want to see past sessions — energy delivered and roughly what it cost.*

- Today's transactions table → **mobile cards**: date, duration, kWh, and **(new) estimated cost** (kWh × price at the time). Tap → the existing session chart (power / current / SoC). Optional weekly total header.

### 4.6 Settings / System

> **Story:** *As a user, I manage chargers, car, region, house power, and check system health in one place.*

Sub-sections: **Chargers** (add/edit/remove — re-enters wizard steps), **Vehicles** (Skoda login/logout, guest defaults), **Electricity region**, **House & load balancing** (breaker, meter, safe static current), **System status** (health as plain-language module list), **Backup / restore**, **About**.

---

# PART 5 — User stories (0.3.0 — phased out)

### 5.1 Automatic car detection

> **Story:** *When I plug in my own car, the app recognizes it instead of defaulting to Guest.*

Heuristic: correlate a known vehicle's charging/connector-state transition timing with the loadpoint's session start; confidence-scored. UI: *"Detected Enyaq — not your car? Switch."* Fallback = Guest.

### 5.2 Climate / preconditioning-triggered charging

> **Story:** *When my car starts preconditioning, wake the charger so the car can pull power for battery/cabin preheat (some cars only precondition the **battery** when the charger is delivering power).*

Rule: if climate/precondition is active AND plugged in AND mode ≠ Off → ensure current is offered even outside a cheap window, with a **guardrail/timeout**. Explicitly Skoda-specific and best-effort.

---

# PART 6 — UX capability checklist for 0.2.0

The frontend needs these backend contracts to exist. Summarized; detailed in Part 8.

- Read **and write** structural config (chargers, loadpoints, tariff zone, balancer/breaker, vehicles).
- A **first-run / is-configured** signal.
- **Pending/unclaimed charger** discovery + live "charger connected" event, and a "claim" action.
- **Plans** CRUD (per charger: day mask, ready-by, target value + unit, enabled).
- **km→%** and **kWh** target support with graceful offline behavior.
- **Estimated cost** per session.
- Clean **kW/current** and **session-energy** values (fix known meter bugs).

---

# PART 7 — Gap analysis (described vision vs. what the backend does today)

*Backend/logic only — UI excluded. Grounded in the current code (file:line citations from a July 2026 code sweep; verify against current code before implementing).*

| Vision feature | Exists today? | Backend gap to close |
|---|---|---|
| **Onboarding wizard / first-run** | ❌ Config is immutable YAML (`config.ts` load-only, no writer anywhere); no first-run concept | Topology as a **JSON config document in SQLite** with a declarative `GET`/`PUT /api/config` (zod-validated); an "is-configured / first-run" flag; one-time YAML→document import + document→YAML export |
| **Charger pairing / "detect my charger"** | ⚠️ All WS connections accepted (`charger-ocpp16/server.ts` `accept()`); unknown stations orphan; no discovery API | Track **pending/unclaimed** stations; expose via API + SSE event; a "claim" flow that creates charger+loadpoint config |
| **Electricity region at runtime** | ⚠️ Zone is per-tariff YAML, read-only (`tariff-elering/index.ts`) | Writable tariff config; re-init/reload tariff module + re-fetch on change |
| **Multiple plans per charger** | ❌ Single `targetSoc`+`targetTime` on `LoadpointState` (`loadpoint.ts`) | New **plans** table + **plan-resolution** logic; feed the *resolved* plan into the existing planner |
| **Day-of-week recurrence** | ❌ `targetTime` is a bare HH:MM, next-occurrence only (`lifecycle.ts` `parseTargetTime`) | Day-mask gating; compute next ready-by datetime from mask |
| **Target in %** | ✅ `targetSoc` 0–100 (`config.ts`) | — reuse as-is |
| **Target in km** | ⚠️ `range` read from Skoda & cached (`vehicle-skoda/index.ts`, `vehicle_cache.range_km`), but never a target; no conversion | km→% conversion from live range/SoC ratio; store target **unit**; persist last ratio for offline durability |
| **Target in kWh (Guest, no car)** | ❌ | Small add — planner already thinks in `requiredKWh` (`planner.ts`), so a kWh target is the *most direct* input |
| **Battery-capacity durability** | ✅ **Largely done** — capacity fetched once, cached in SQLite (`vehicle_cache.battery_capacity_kwh`), estimator `lastSoc + kWh·0.92/capacity` survives outage (`estimator.ts`) | Also persist the **km↔% ratio** + last range; ensure Guest/kWh path never needs capacity |
| **Guest vs detected car** | ❌ No guest concept; static 1:1 VIN mapping (`config.ts`, `lifecycle.ts`) | Model a **vehicle profile** on the loadpoint with a **Guest** default; record per-session which profile was used |
| **Automatic car detection** (0.3.0) | ❌ | Correlation heuristic; needs connector/plug state — Skoda gives a coarse `state` enum currently **discarded** (`vehicle-skoda/index.ts` keeps only `=== 'CHARGING'`); re-expose it |
| **Climate-triggered charging** (0.3.0) | ❌ **Zero** climate support anywhere (grep confirms) | Skoda climatisation endpoint (port from evcc); extend **Vehicle interface** with climate/precondition + connector state; loadpoint trigger rule + guardrail |
| **Estimated cost in history** | ⚠️ `transactions` + `meter_values` stored (`db.ts`); no cost | Join session energy × tariff price-at-time → cost; small aggregation endpoint |
| **Trustworthy live values** | ✅ Resolved (2026-07-04, see `ROADMAP.md`): live `currentA`/`sessionEnergy` now survive restart/reconnect; session energy is the delta; `defaultMode`/targets seed the DB with a declarative `config:apply` escape hatch | Foundation done — redesign can rely on `/api/loadpoints` live values |

**Headline:** the single biggest gap is that **config is immutable at runtime** — onboarding + live plan/charger editing is net-new architecture, not a UI skin. The single biggest *pleasant surprise* is that **capacity-based durability already works**, so km/% offline behavior mostly reuses the existing estimator.

---

# PART 8 — Backend / logic roadmap

## 0.2.0 workstreams

**W1 — Config as data (the enabler).** SQLite becomes the single *live* source of truth; YAML is import/export only.
- **Topology as one JSON document, not table-per-entity:** a single-row `config_document` table in `src/core/db.ts` holding the whole topology config (chargers, meters, tariffs, balancers, vehicles, site) as validated JSON. Far less code than normalized tables, and round-trips to/from YAML trivially. (`plans` is the one normalized table — see W3.)
- **Declarative surface:** `GET /api/config` returns the document; `PUT /api/config` validates with the **existing zod schemas** in `src/core/config.ts` (DRY — don't fork validation) and replaces it. Tests PUT a fixture document.
- `loadConfig()` gains a DB-backed path; on first 0.2.0 boot with no document, **import `osc.yaml` → document** once (guarded by an `is-configured` flag), then the DB wins and YAML is never read live again. Provide document→YAML export (complements `scripts/backup.mjs`, which already covers the whole DB).
- **Soft in-process reload:** refactor `lifecycle.ts`'s boot into a `buildRuntime(config)` / `teardown()` pair so `PUT /api/config` tears down and rebuilds the whole module graph in-process — a full rebuild, **not** hot-diffing individual modules (KISS/low-risk). Plans and live mode/target are read each balancer tick, so their edits need no reload.

**W2 — Config API + pairing.** In `src/server/api.ts`:
- **Primary surface is the declarative document** from W1 (`GET`/`PUT /api/config`). Topology changes are rare, so the UI can read-modify-write the whole document; granular per-entity endpoints are optional — add them only where a flow genuinely needs one.
- **Pending stations:** in `src/modules/charger-ocpp16/server.ts`, track connected-but-unclaimed stationIds; expose `GET /api/stations/pending` + an SSE `station.connected` event; a "claim" action adds the charger + loadpoint to the config document (W1) and soft-reloads.
- Expose a first-run/is-configured flag (the existing read-only `GET /api/site` projection can remain as a convenience, or fold into `GET /api/config`).

**W3 — Plans model & resolution.**
- New `plans` table: `(id, loadpoint_name, days_mask, ready_by, target_value, target_unit['soc'|'km'|'kwh'], enabled)`.
- New `src/core/plans.ts`: given now + a loadpoint's plans → resolve the governing plan → produce `{ requiredKWh, targetTime }` and hand to the **existing** `plan()` in `src/core/planner.ts` (unchanged) and the tariff gate in `lifecycle.ts`.
- CRUD endpoints in `api.ts`.

**W4 — km / kWh targets + durability.**
- km→%: `ratio = range / soc` (live), `requiredSoc = targetKm / ratio`; **persist the ratio** (extend `vehicle_cache` / `module_kv`) so km targets survive a vehicle-API outage; freeze last ratio when offline.
- kWh target: feed `requiredKWh` directly to the planner (Guest-friendly, no capacity needed).
- Reuse `estimateSoc()` (`src/core/estimator.ts`) untouched.

**W5 — Cost in history.** Aggregation endpoint joining `meter_values`/`transactions` energy with `tariff_slots` price-at-time → estimated cost. Read-only; no schema change beyond a query.

**W6 — Foundation fixes.** ✅ Done (2026-07-04, see `ROADMAP.md` "Resolved"): live `currentA`/`sessionEnergy` survive restart/reconnect, session energy is the delta, `defaultMode`/targets seed the DB (+ declarative `config:apply`), `dev:ui` blank page, reconnect health refresh, and the off-boundary smart-charge price bug. (Note: Swedish `elprisetjustnu` prices are genuinely 15-min; the "hourly" note applied to Elering/Nord Pool day-ahead.)

## 0.3.0 workstreams

**W7 — Automatic car detection.** Re-expose the discarded Skoda `state` enum (`READY_FOR_CHARGING` etc.) and add connector/plug state; correlation heuristic between vehicle transitions and loadpoint sessions; confidence + Guest fallback.

**W8 — Climate-triggered charging.** Port Skoda climatisation status (evcc reference); extend `src/sdk/vehicle.ts` `VehicleData` with climate/precondition state; loadpoint trigger rule with guardrail/timeout in `lifecycle.ts`.

## Critical files (for whoever implements)
- `src/core/db.ts` — new config + plans tables, migrations
- `src/core/config.ts` — reuse zod schemas for API validation; DB-backed load + YAML import/export
- `src/core/plans.ts` *(new)* — plan resolution
- `src/core/planner.ts`, `src/core/estimator.ts` — **reuse as-is**
- `src/core/lifecycle.ts` — reconfigure path; plan-resolution wiring
- `src/server/api.ts` — `GET`/`PUT /api/config`, plans CRUD, pairing, cost endpoints
- `src/modules/charger-ocpp16/server.ts` — pending-station tracking + SSE
- `src/sdk/vehicle.ts`, `src/modules/vehicle-skoda/*` — (0.3.0) climate + connector state
- Docs to update: `docs/config.md`, `docs/architecture.md` ("immutable at runtime" is no longer true), `docs/modules.md`, `ROADMAP.md`

---

# PART 9 — Key architectural decisions & open questions

1. **Apply model for topology changes** — **decided:** soft in-process reload (`buildRuntime`/`teardown`, full rebuild, no hot-diffing, no container restart). Plans/mode changes are instant (read each tick).
2. **Config store** — **decided:** SQLite is the single live source of truth (topology as one JSON document + `plans` table); YAML is import/export only. Rules out a dual YAML+DB source.
3. **Plan conflict resolution** — recommend *earliest upcoming ready-by among today's active plans wins*; alternative is user-ordered priority. *(Open.)*
4. **km target when offline** — recommend *freeze & persist last known range/SoC ratio*; degrade to % if never seen. Confirmed the Enyaq's reported range already tracks seasonal derating, so a linear ratio is sound. *(Open detail.)*
5. **Migration** — one-time YAML→document import on first 0.2.0 boot; keep YAML export for the git/backup workflows self-hosters expect.

---

# PART 10 — Verification approach (per workstream, for implementation)

Each backend workstream ships with an end-to-end check, on top of the existing `npm run build && npm start` + `npm run smoke` gates:
- **W1/W2:** run onboarding against `scripts/sim-charger.mjs`; confirm a claimed station produces a live loadpoint via soft reload (no process restart), and that after a real restart config still loads from the DB document (YAML is not re-read). PUT a fixture config document and confirm the module graph rebuilds to match it.
- **W3:** create two overlapping plans and assert the resolver picks the earlier ready-by; verify a day-mask that excludes today yields "no active plan."
- **W4:** set a km target with a connected vehicle, then simulate a vehicle-API outage and confirm the frozen ratio keeps the target sane; set a kWh target with no vehicle (Guest) and confirm the planner charges the right amount.
- **W5:** compare a computed session cost against a manual kWh × slot-price calculation.
- **W6:** confirm `currentA`/`sessionEnergy` read correctly against real or simulated meter values.
