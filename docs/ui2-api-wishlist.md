# ui2 → backend API wishlist

**For the agent working on the backend/API.** While wiring `src/ui2` to the real backend we found a
set of controls the UI already models but the API can't back yet. They're **not bugs** — ui2 now shows
these values truthfully (read from `GET /api/site`) and renders the controls **read-only in live mode**
with a "set in your config file (osc.yaml)" note, so nothing is misleading in the meantime. This is the
list of write capabilities that would let us un-lock those controls. Ordered by value.

Reference: everything below is currently **file-driven** (`osc.yaml` → `npm run config:apply` → restart).
Only `timezone`, loadpoint `mode`/`target`/`minSoc`, and plans CRUD are runtime-writable today.

---

## 1. Runtime "site knobs" — region + main breaker (highest value, cheapest)

The two things a user most obviously wants to change from the app, and the ones that prompted this list.

- **Tariff zone / region** (e.g. `SE3` → `SE4`). Exposed read-only today as `GET /api/site.tariffs[].zone`.
- **Main breaker `mainBreakerA`** (e.g. `25 A` → `16 A`). Exposed read-only as `GET /api/site.site.mainBreakerA`
  (and `balancers[].mainBreakerA`).

**Suggested shape (mirrors the existing timezone pattern — likely the cheapest path):** extend
`GET/PUT /api/settings` (which already round-trips `timezone` through the `settings` KV in
`core/settings.ts`) to also read+write `region` and `mainBreakerA`. Emit the existing `settings.changed`
SSE (or a `site.changed`) so clients reconcile. ui2 already has the `setTimezone` command pattern to copy
for these.

> If these live in the `settings` KV, please also make the running tariff/balancer modules read the KV
> value (not just the boot-time `osc.yaml` value), so a change actually takes effect without a restart.

## 2. Balancer settings (runtime)

Source/type (`tibber` / `mqtt` / `static`), `phases`, and the static safe-limit amps. Today all
file-only (`balancerConfigSchema`). Same delivery as #1 (settings KV or a `PUT /api/balancers/:name`).
Backs **Settings → House**.

## 3. Charger management API

Pair/claim a newly-detected OCPP charger, rename, set configured `maxCurrentA`, and remove. Backs the
**"Add another charger"** onboarding flow and **Settings → Chargers** name/max-amps (all read-only now).
Ideally a "pending/unclaimed OCPP connections" read + a claim write, so the onboarding "waiting for
charger… → claim" UX becomes real instead of simulated.

## 4. Vehicle management API

Add a vehicle with provider credentials (Škoda / VW login), and remove. Backs the **car** onboarding step
and **Settings → Vehicles → Connect** (currently a mock that adds a hardcoded Enyaq and ignores creds).
The vehicle *list* is already real (from `GET /api/site` + `GET /api/vehicles/:name`).

## 5. Config-change SSE

A `site.changed` / `config.changed` event (like `settings.changed` / `loadpoint.plans`) so multiple open
clients stay in sync when any of the above change. ui2 already has the `subscribe(...)` seam.

## 6. Consistency fixes in `GET /api/site` (small, worth doing alongside)

- `site.site.timezone` returns the **osc.yaml** value; after a `PUT /api/settings` it diverges from
  `GET /api/settings.timezone` (the runtime value). ui2 reads `/api/settings` for tz to avoid this — but
  aligning `/api/site` (or documenting it) would prevent future foot-guns.
- `site.loadpoints[].{targetSoc,targetTime,targetKWh,autoStart}` are **config defaults**, not the live
  runtime targets (those are on `GET /api/loadpoints/:name`). Same caveat.

## 7. (Already in flight) resolved plan target %

Tracked separately via the target-model rework in `docs/ui2-backend-handoff.md` (`PlanDto.resolvedSoc` +
`availableTargetUnits`). Noted here only for completeness.

---

## What ui2 already does with the read-only data (so you can see the seam)

- `useLiveSync` hydrates `config.region` / `config.breakerAmps` from `GET /api/site`
  (`tariffs[0].zone`, `site.mainBreakerA`) on startup.
- Settings screens gate every no-write-API control on `source === "live"`: read-only + a
  `ConfigLockNote` in live, fully interactive in demo (the mock playground).
- When you ship a write endpoint, un-locking a control is roughly: add a `commands.ts` wrapper
  (optimistic local + `if (isLive()) await api.…`), drop the `disabled`/`locked` gate, and subscribe to
  the new SSE. Same shape as the `timezone` control we just added.
