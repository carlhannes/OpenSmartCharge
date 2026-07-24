# Known issues — real-hardware findings

Running log of bugs/quirks found during live testing, to gather and fix later. Newest batch first.
Each entry: **Symptom** (what was seen) · **Evidence** · **Where** · **Root cause** · **Fix idea** · **Severity**.

---

## 2026-07-15 — Logs/times shown in UTC, not the server timezone

### 1. Log timestamps rendered in UTC instead of Europe/Stockholm  ·  severity: low (UX, owner-flagged)

- **Symptom:** log times are shown in UTC on human-facing surfaces, not the server's configured timezone
  (Europe/Stockholm). Owner directive: logs must **always** read in the server tz, **never** UTC.
- **Where:** (a) `src/core/log-store.ts` `exportLogsText` writes the raw ISO string `e.time`
  (`2026-07-15T12:19:38.514Z …`) → the exported `.log` is entirely UTC. (b) the ui2 viewer
  `src/ui2/src/routes/settings.logs.tsx` (`fmtClock(new Date(e.time))` + `new Date(e.time).toLocaleString()`,
  via `src/ui2/src/lib/logs.ts`) formats with the **browser's** timezone — correct only by accident when the
  browser is in Stockholm, not pinned to the server tz.
- **Root cause:** storage is UTC ISO in the `logs.time` column (correct: sortable, DST-safe, retention prunes
  via a string `WHERE time < cutoff`), but nothing converts to the server tz at display time.
- **Fix idea:** convert to `Europe/Stockholm` at every display surface — the export formatter, the ui2 viewer
  (pin the formatter to the server tz, already known via `settings.timezone`), and agent/chat reporting. **Keep
  storage UTC** (convert only for display): storing local strings would reintroduce the DST fall-back hour as a
  duplicated/ambiguous timestamp and break the string sort + retention pruning.
- **Severity:** low — display-only; charging + stored data unaffected.

### 2. Confirm SoC with a one-shot poll when the estimate reaches target (don't wait for the cadence)  ·  severity: low (enhancement)

- **Symptom:** when the backend's SoC *estimate* (anchor + kWh × efficiency ÷ capacity) reaches the plan
  target, it pauses charging + marks Ready immediately — but the car's REAL SoC isn't re-polled until the
  next cadence poll (~15 min drawing / ~10 min idle-day), so the displayed % + the final confirmation can
  lag minutes (owner saw ~73% / "still charging" for ~1 min before a poll caught it up to 75% + paused).
- **Where:** `src/core/smart-charging/vehicle-poll.ts` `shouldPollVehicle` warrants only on connect + the
  drawing/idle cadence + failure-backoff — no "estimate crossed target" warrant. `maybePollVehicles`
  (`src/core/lifecycle.ts`) drives it.
- **Fix idea:** a ONE-SHOT confirmation poll when the estimate first crosses the target this session
  (debounced, reset on unplug — same demand-driven pattern as the connect poll). Bonus: self-corrects an
  optimistic estimate (real SoC below target → charging resumes) instead of falsely finishing early, and
  refreshes the displayed % promptly.
- **Severity:** low — behaviour is correct; this only tightens the confirm/display latency.

---

## 2026-07-14 — UI derives the charge "plan" on the frontend

### 1. Charger chart computes the "cheap window" client-side, deadline-unaware  ·  severity: medium

- **Symptom:** the charger-detail chart _"Next 24 hours · price & plan"_ shades a "cheap window" that
  ignores the ready-by. With target **75% by 07:00**, it shaded the genuinely-cheapest block at **midday
  (~11–14)** — hours the car can't use before an 07:00 deadline. It's labelled "plan" but shows no actual
  backend plan (just a price curve + a client-side cheapest-hours guess + the ready-by marker).
- **Evidence:** live prices min `0.674` / max `2.433` kr/kWh matched the chart's `0.67`/`2.43` (so the
  _price_ data is correct), but the cheapest slots (11:45–14:30) are **after** the 07:00 ready-by, while the
  backend was correctly `shouldChargeNow:false`, waiting for the cheapest pre-07:00 slots. The chart
  contradicts what the backend will actually do.
- **Where:** `src/ui2/src/components/charger/Timeline24h.tsx` calls `cheapWindows(prices)` from
  `src/ui2/src/lib/mock/prices.ts` — a naive "cheapest ~35% of prices" threshold
  (`threshold = prices.sorted[floor(len*0.35)]`) that takes **only prices** (no target, no deadline, nothing
  from the planner). Prices are also downsampled to 24 **clock-hour** buckets in
  `src/ui2/src/lib/live/map.ts` (`new Array<number>(24)`), so the axis is a "today 00–24" view, not the
  titled "next 24 h".
- **Root cause:** the frontend **recomputes charging intent** instead of deriving it from the backend. The
  planner (`src/core/planner.ts`) already computes the deadline-constrained schedule every tick (cheapest
  slots within `[now, readyBy]` that add the required kWh) — it just isn't exposed over the API, so the UI
  fills the gap by guessing from prices.
- **Fix idea:** (1) **Backend** — expose the planner's schedule for a loadpoint, e.g.
  `GET /api/loadpoints/:name/plan` → the selected charge slots over the window + the price series +
  ready-by. (2) **Frontend** — `Timeline24h` renders _that_ (selected slots + prices + ready-by marker);
  delete the `cheapWindows` / `mock/prices` client-side computation, and make the window a true
  next-24h-from-now. Principle (owner's call, 2026-07-14): **everything is derived from the backend — no
  price/plan logic on the client.**
- **Severity:** medium — display-only. The backend charges correctly; the chart just misleads.
- **Resolved (2026-07-16, `feat/ocpp-zaptec-charging`):** the backend now exposes the planner's real
  forward schedule via `GET /api/loadpoints/:name/plan` — the tick stores the schedule it already computes
  (`state.plannedSlots`, from `decideShouldCharge`), and `buildPlanSeries` (`src/core/planner.ts`) merges it
  with a 24 h price fetch. `Timeline24h.tsx` renders those backend slots on a true rolling now→now+24 h axis;
  the client-side `cheapWindows` guess is deleted from the live path (demo mode synthesizes its own,
  deadline-aware, slots). The shaded charge window is now the cheapest hours BEFORE the ready-by, matching
  `resolve.shouldChargeNow`.

---

## 2026-07-08 — live session (WiFi switch, charger reboot, stale Skoda)

Context: the laptop was briefly on the wrong WiFi. The Zaptec Go (LAN/OCPP) dropped and rebooted; the
Skoda (MySkoda cloud) polls had been failing for hours. Surfaced a cluster of health/status-reporting,
data-freshness, and recovery bugs.

### 1. False "charging continues" banner when the charger itself is down  ·  severity: high
- **Symptom:** UI showed *"Something's degraded — charging continues."* while the OCPP charger was **not
  connected**. As the user put it: "that's just wrong" — charging can't continue if the charger is offline.
- **Where:** `src/ui2/src/routes/index.tsx:17,31` — `degraded = moduleHealth.filter(m => m.status !== "ok")`
  and a hardcoded string `"Something's degraded — charging continues."` shown for **any** non-ok module.
- **Root cause:** the banner conflates two very different degradations. OSC's design is that degradation of
  **resolver inputs** (tariff/meter/vehicle → the energy/price/current fallback ladders) means charging
  continues on a fallback — true. But degradation of the **charger/OCPP control path** means charging
  **cannot** happen. The banner assumes the former for everything.
- **Fix idea:** make the message conditional on *which* module is degraded. Charger/OCPP `unavailable` →
  "Charging stopped — charger offline." A data-source (tariff/meter/vehicle) degraded → "Charging continues
  on a fallback." Possibly derive a single "is charging actually possible right now" signal on the backend.

### 2. Module health is not liveness/accuracy-aware  ·  severity: high
- **Symptom:** `GET /api/health` reported `garage: ok` and `enyaq: ok` in states where that was misleading —
  the charger connected-but-idle (no session), and the vehicle with a ~10.7 h-stale reading + actively
  failing polls.
- **Evidence:** `enyaq: ok` while the last good Skoda reading was 643 min old and recent polls were 403/500;
  `garage: ok` throughout (the OCPP WS liveness was confirmed separately via GetCompositeSchedule, but health
  doesn't distinguish "WS up + car session" / "WS up, no car" / "WS down").
- **Root cause:** health is a coarse per-module ok/degraded/unavailable that isn't tied to data freshness or
  connector/session state.
- **Fix idea:** make `health()` staleness-aware per module (esp. vehicle — mirror the meter reader's
  `staleAfterSec`), and have the charger health reflect WS-heartbeat recency + connector state. Feeds #1/#3.

### 3. Settings → System status page doesn't reflect actual status  ·  severity: med
- **Symptom:** the status page in UI settings didn't reflect the real module status.
- **Where:** `src/ui2/src/routes/settings.system.tsx` renders `store.moduleHealth`; refreshed only by a poll
  in `src/ui2/src/lib/live/useLiveSync.ts:276` (`setInterval(getHealth, HEALTH_POLL_MS)`), errors swallowed
  (`.catch(() => {})`, line ~140). **No `health.changed` SSE event exists.**
- **Root cause:** health is poll-only (lags the interval; a failed poll silently keeps stale values) and the
  page shows whatever the last poll returned. Compounded by #2 (the underlying values are themselves coarse).
- **Fix idea:** add a `health.changed` SSE event (emit on transitions) so status is live; surface poll
  failures instead of swallowing; verify the page renders per-module health clearly (incl. charger offline).

### 4. Skoda/vehicle does not auto-recover from transient API failures  ·  severity: high
- **Symptom:** the vehicle showed as disconnected/stale and never recovered on its own; only a manual force
  refresh fixed it.
- **Evidence:** MySkoda `/v1/charging/{vin}` returned **HTTP 403** (auth) for hours, then **HTTP 500**
  (server). Last good reading was ~10.7 h stale (SoC 77 from before a drive). `POST /api/vehicles/enyaq/refresh`
  succeeded immediately (SoC 54, pluggedIn) — so the integration was healthy again but nothing had re-polled.
- **Root cause:** (a) demand-driven polling → no poll while the car is idle and the charger is disconnected
  (no connect event); (b) no retry/backoff to recover after transient 403/500; (c) vehicle `health()` stays
  `ok` on stale data (see #2), so nothing flags it.
- **Fix idea:** staleness-aware vehicle health; a recovery poll / backoff after failures (so a transient blip
  self-heals within minutes, not hours); surface "last updated N min ago / stale" in the UI.

### 5. ui2 vehicle state is startup-only + SoC-only on SSE  ·  severity: med
- **Symptom:** after the backend got fresh vehicle data (forced refresh), the UI still showed the old
  pluggedIn/state; only SoC would update.
- **Where:** `src/ui2/src/lib/live/useLiveSync.ts` — full vehicle DTO (`getVehicle`→`mapVehicle`) is fetched
  **once at startup**; the only live update is `subscribe("vehicle.poll", … patchVehicle({soc}))` — **SoC only**.
- **Root cause:** `vehicle.poll` SSE carries `{name, soc}` only, and nothing re-fetches the full vehicle.
- **Fix idea:** on `vehicle.poll`, re-fetch `GET /api/vehicles/:name` (or widen the SSE payload to the full
  reading) so pluggedIn/state/range/target reflect live.

### 6. Charger reboot → connector "Available" → session lost, no charging in any mode  ·  severity: high
- **Symptom:** car plugged in (Skoda `pluggedIn:true, CHARGING_INTERRUPTED`) but OSC `connected:false`; fast
  mode offered 16 A yet nothing charged.
- **Evidence:** `20:50:47 BootNotification` (Zaptec rebooted on reconnect) → `20:50:49 StatusNotification
  connector 1 = Available` → fast mode `SetChargingProfile amps:16 Accepted` but `skoda isCharging:false`.
- **Root cause:** a charging profile sets a **ceiling**, not a session. With the connector `Available` (no
  transaction) nothing charges, regardless of mode. The Enyaq (post-interruption) doesn't re-initiate; the
  reboot dropped the session.
- **Fix idea:** when OSC sees `vehicle.pluggedIn === true` but the connector is `Available`/`connected:false`,
  attempt a recovery (RemoteStart, or Stop+Start like the resume-nudge) and/or clearly surface the mismatch
  ("car says plugged, charger reports no session — try replugging"). Relates to the documented Enyaq latch.

### 7. Car plugged but won't charge — root cause + the recovery that worked  ·  severity: high · RESOLVED (manually)
- **Symptom:** car plugged (Skoda `pluggedIn:true`), Zaptec ring pure white, connector stuck `Available`;
  RemoteStart got it to `Preparing` but it timed out (~63 s ConnectionTimeOut) back to `Available` without
  ever drawing; a fresh transaction (tx 17) reached `SuspendedEV` but still drew 0 A. No charger-side lever
  (RemoteStart, soft reset, ClearChargingProfile, RemoteStop+Start) made the car draw.
- **ROOT CAUSE (confirmed via MySkoda):** charging was switched **OFF at the car** — `GET /v1/charging/{vin}`
  showed `chargeMode: "OFF"` (that *is* the `CHARGING_INTERRUPTED` state). The charger and OCPP were fine the
  whole time; the car simply refused to charge. No charger-side command can override a car-side "off."
- **RECOVERY THAT WORKED (no physical replug):** ① OCPP **Hard** reset (`POST …/reset {type:"Hard"}`) → a
  *cold* control-pilot re-assertion (software-equivalent of a replug) → the charger opened a fresh session
  (`SuspendedEV`). ② A **MySkoda cloud start-charge** (`POST mysmob…/v1/charging/{vin}/start`, authed via the
  cached refresh token) fired **into that open session** → the car un-suspended and began drawing (~9.8 A).
  **Order matters** and **both are required** — `/start` with no active session 202-no-ops or 500s; Hard reset
  alone lands in `SuspendedEV`; a soft reset / bare RemoteStart don't wake it.
- **Fix ideas:** (a) give OSC a first-class **car-side start-charge** (MySkoda `start`/`stop`) so it can
  recover a `chargeMode:OFF`/`SuspendedEV` car without manual scripting or a replug; (b) an auto-recovery that,
  on `vehicle.pluggedIn && connector Available/SuspendedEV && drawing 0 A`, runs Hard-reset→start-charge;
  (c) the existing resume-nudge (RemoteStop+Start) did **not** cover this state — extend/verify it.

### 8. Tariff is empty → "Next 24 hours · price & plan" blank, smart charging degraded  ·  severity: high (for tomorrow)
- **Symptom:** the 24-hour price & plan view is empty; resolver on `price: "historical-avg"` (degraded).
- **Evidence (confirmed):** `GET /api/tariffs/home/prices` returns **0 slots for now→+24 h**, and only **2
  stale slots total** in −24 h→+36 h (both `2026-07-07T21:30–22:00Z`, ~a day old). **No tariff/price/fetch
  log lines** in the last 250 debug entries — the provider isn't fetching (or isn't logging that it tries).
  Meanwhile `GET /api/health` reports the tariff (`home`) as **`ok`** despite having no data (health-accuracy,
  ties to #2).
- **Root cause (to confirm):** the elprisetjustnu (SE4) fetch isn't populating `tariff_slots` — likely failed
  during the no-internet window and hasn't retried (no visible retry/backoff, same shape as #4), and possibly
  the fetch cadence/schedule doesn't re-attempt soon after connectivity returns. Not a ui2 issue (the API
  genuinely has no data).
- **Fix idea:** investigate the tariff module's fetch schedule + error handling (retry/backoff after a failed
  fetch; a fetch on connectivity-regain / boot); make tariff `health()` reflect "no usable price data" instead
  of `ok`; ui2 should show "prices unavailable" rather than a blank. Consider a `POST /api/tariffs/:name/refresh`
  (like the vehicle's) for a manual kick.
- **Tonight:** does **not** block the charge — fast mode ignores prices. Matters for tomorrow's *smart* charging.

### 9. Logs viewer default level (warn) hides routine activity  ·  severity: low (UX)
- **Symptom:** "the Skoda polls don't show up in the logs" — because successful polls (`skoda refresh ok`)
  and `circuit resolve` decisions log at **debug**, and the viewer defaults to the **warn** filter.
- **Where:** `src/ui2/src/routes/settings.logs.tsx` (`useState<LogLevel>("warn")`).
- **Fix idea:** consider defaulting to `info`, or a subtle hint that debug/info are hidden at the current
  filter. (Working as designed, but poor discoverability.)

### 10. Balancer stalls the charger to 0 A (below the 6 A IEC min) → risks re-latching the car  ·  severity: high
- **Symptom:** with `mainBreakerA` set for a safety margin (tried 12 A) and a real household load of ~8.4 A on
  one phase, the live-meter budget was `12 − 8.4 = 3.6 A` → below the 6 A IEC minimum → floored to **0 A**, so
  the charger **paused mid-session**. A 0 A pause is exactly what makes the Enyaq latch `SuspendedEV` and not
  auto-resume — i.e. an over-tight breaker can silently kill an overnight charge.
- **Root cause:** the current ladder floors sub-6 A budgets to 0 (correct per IEC) but nothing weighs that
  against the cost of a stall (re-latch). The margin you *can* keep while still charging is bounded:
  `fuse − household − 6` (here 16 − 8.4 − 6 = **1.6 A** max). So on a 16 A fuse with an 8.4 A cycling load you
  cannot have both a big margin and uninterrupted ≥6 A charging.
- **Workaround used tonight:** set `mainBreakerA` to **15** — keeps the charger ≥6 A through the 8.4 A cycles
  (no stall/re-latch) while holding ~1 A margin during spikes and ~5 A when the load is off.
- **Fix ideas:** treat "would drop below 6 A" as a *throttle-to-6-and-hold* (or a brief, resume-guaranteed
  pause) rather than a hard 0; make the resume path after any 0 A reliable for this car; surface the
  fuse/household/min-charge tension in the UI so the user isn't unknowingly starving the charger.

### 11. Dynamic balancing can't prevent control-lag OVERSHOOT — needs a fixed safety cap  ·  severity: high
- **Symptom:** with the charger at 9.8 A (set when household was low) and `mainBreakerA:15`, the phase-2
  household load spiked to ~8.4 A between control ticks → **phase hit 18.2 A (2.2 A OVER the 16 A fuse)** for
  <60 s until the 30 s balancer tick throttled the charger. The fuse held (short-overload tolerance), but this
  is exactly the "don't blow the fuse" risk.
- **Root cause:** the live-meter balancer only re-computes every `controlIntervalSec` (30 s). Between ticks the
  charger holds its last commanded current, so **any fast household step adds directly on top of it** — the
  balancer is reactive, not predictive, and can't stop a mid-interval overshoot. Targeting `total = breaker`
  leaves nothing for the lag.
- **Mitigation used:** hard-cap the charger low enough that `chargerMax + worstHouseholdSpike < fuse`
  regardless of timing — set charger `maxA:6` (6 + 8.4 = 14.4 A, always safe, no reaction needed). Cost: slower
  charge (~4.1 kW), but fine given a large deadline window.
- **Fix ideas:** (a) a configurable safety headroom the balancer subtracts (target `breaker − N`), plus a
  hard per-charger ceiling that bounds the un-reacted overshoot; (b) faster reaction (shorter tick, or event-
  driven on each meter frame — the meter is ~10 s) so the lag window shrinks; (c) predictive/derating when the
  meter trend is rising. Dynamic balancing to the fuse is inherently unsafe without one of these.

---

### Cross-cutting theme
Several of these (#1, #2, #3, #4) are one underlying gap: **OSC's health/status reporting is coarse and not
freshness/liveness-aware**, so the UI can't honestly say "is charging actually happening / is each module's
data fresh." A single accurate "charging possible + why/why-not" signal on the backend, plus staleness-aware
per-module health and a `health.changed` SSE event, would fix the reporting layer that #1–#3 all sit on.
