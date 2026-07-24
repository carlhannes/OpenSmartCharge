# Live test checklist — car plugged in

What to verify **on the real vehicle** that the unit tests can't. Run through this the next time the
Enyaq is plugged in. The automated side (176 tests, typecheck, lint) is already green — this is the
on-vehicle complement, with emphasis on the **2026-07-05 target-model + per-session-efficiency +
capability** pass.

Tip: run the backend with debug logs so the greps at the bottom work —
`nohup env LOG_LEVEL=debug ./node_modules/.bin/tsx src/core/lifecycle.ts > data/osc-live.log 2>&1 &`

## 0. Pre-flight (before plugging in)

- [ ] Backend is on the **latest code** (if a backend was left running on old code, stop it and restart).
- [ ] Vehicle bound to the loadpoint in `osc.yaml` (`enyaq` → `garage`).
- [ ] Baseline the car: `curl -s localhost:8080/api/vehicles/enyaq` — note `soc` / `range` / `state`.

## 1. Capability + resolvedSoc (the target-model change)

- [ ] On connect, **exactly one** vehicle poll fires (log: `skoda refresh ok` with `soc`/`range`), then not again while idle.
- [ ] `GET /api/loadpoints` → the loadpoint's **`availableTargetUnits`** is `["pct","km","kwh"]` (car reports soc + range + capacity).
- [ ] Create a **km** plan (e.g. 350 km) → `GET …/plans` → its **`resolvedSoc`** ≈ `350 ÷ (range ÷ soc)`. Check the arithmetic by hand against the car's current range/soc.
- [ ] That `resolvedSoc` equals the % the backend actually charges to — cross-check `active plan governs` + `circuit resolve` (energy source `soc-capacity`).
- [ ] A **kwh** plan → `resolvedSoc: null` (UI shows raw kWh, not a fake %).

## 2. km target charges to the right point

- [ ] With a km plan governing, charging stops near the **resolved %**, not the raw km number.
- [ ] Confirm via `SetChargingProfile result` (amps) + `StatusNotification` (`Charging` → `SuspendedEVSE` when target reached).

## 3. Per-session efficiency (the key new behavior)

- [ ] Let it charge through **≥2 vehicle polls** (~30 min apart) with **≥~3 kWh and ≥2% SoC** gained between them — the threshold for observed efficiency to engage.
- [ ] Indirect accuracy check: just before a real poll, note the estimated SoC; it should land **close to** the next `skoda refresh ok` reading (tighter than the generic 0.92 would give for this car/conditions).
- [ ] **Car-drop resilience** (optional, the scenario this was built for): if the Skoda API fails mid-charge — or force it by briefly blocking network — the estimate keeps advancing on `charger kWh × observed efficiency` and the charge still **stops near target**. Watch for `vehicle refresh failed` and that it doesn't overshoot.
- [ ] Observed efficiency is now **logged directly** when it engages — grep `using observed session charging efficiency` (each line shows `observedEfficiency` vs the `fallback` constant). Expect it to appear only after the 2nd qualifying poll, and to sit in a plausible band (~0.85–0.95).

## 4. Degradation — no car

- [ ] Unplugged (or no vehicle bound): `GET /api/loadpoints` → `availableTargetUnits` collapses to `["kwh"]`.
- [ ] A km plan's `resolvedSoc` → `null`.
- [ ] Charging still works via the kWh / duty-cycle fallback (doesn't stall).

## 5. Regression sanity (this pass touched the control loop)

- [ ] **Smart deferral** still holds — waits out expensive slots, charges the cheap ones (as in the overnight run).
- [ ] **minSoc floor** still force-charges below the floor (log: `minSoc floor: force-charging past the price wait`).
- [ ] **Deadband** still smooth — no rapid on/off beyond the expected cheap-slot toggling.
- [ ] **Plan resolution** correct — the earliest still-upcoming ready-by governs; falls back to the ad-hoc target when none qualifies.

## Handy log greps

```bash
LOG=data/osc-live.log
grep -a  'skoda refresh ok' "$LOG"                              # vehicle polls (soc/range)
grep -a  'active plan governs' "$LOG"                           # which plan governs
grep -a  'using observed session charging efficiency' "$LOG"    # per-session efficiency (observed vs fallback)
grep -a  'circuit resolve' "$LOG"                               # per-tick decision (shouldChargeNow, sources, budgetA)
grep -aE 'SetChargingProfile result|StatusNotification' "$LOG"  # amps commanded + charger state
grep -aiE '"level":(50|60)|vehicle refresh failed' "$LOG"       # errors / API dropouts
```
