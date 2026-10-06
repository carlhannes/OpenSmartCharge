# OpenSmartCharge — Vision & Roadmap for v0.2.0

> **Historical (written 2026-07; shipped in 0.2.x).** Parts 1–6 — who the user is, the design principles,
> the information architecture, the user stories and the UX checklist — remain the product reference.
> The former Parts 7–10 (gap analysis, backend roadmap, open decisions, verification plan) described a
> design that was built differently in places and have been removed; what exists today is documented in
> `docs/architecture.md`, `docs/config.md` and `ROADMAP.md`.

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

