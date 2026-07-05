# ui2 ↔ backend handoff: plans, timezone, minSoc

**For the agent working in `src/ui2/`.** The backend for the plan UI (and the timezone + minSoc
features) is now live on `feat/ocpp-zaptec-charging`. Your plan/settings model is fully **designed and
built** — it's just **mock/local**. This is the wiring to make it live. No backend changes needed from
your side; the endpoints below are stable. (Line numbers are approximate — verify against your current
code, since we're editing in parallel. I have NOT touched `src/ui2/`.)

> **⚠️ Update (2026-07-05) — target-model rework.** Two additions below, both to move the km→%
> conversion fully into the backend (single source of truth) so the UI never computes it:
> - **`PlanDto.resolvedSoc`** — the backend now computes each plan's display SoC% (km via the car's
>   range/soc ratio, pct passthrough, `null` for kwh or no car). **Display it; delete client-side km→%
>   math** — this supersedes the old "keep your ≈% display as-is" line; the hardcoded efficiency
>   constant and the SoC ring's fake-80% fallback both go away.
> - **`availableTargetUnits`** on each loadpoint (`GET /api/loadpoints`) — the units its data can back
>   right now. **Gate the unit picker on it**: no `km` without range, no `pct` without SoC (always `kwh`).

---

## TL;DR

- **UI is done** (mock): `Plan` model, the `PlanRow` editor in `ChargerDetail`, onboarding step 5, the
  card/hero "ready by · target%" summaries. Keep all of it.
- **What's missing** is purely data plumbing: a REST client + `mapPlan` + hydrate + 2 SSE subs, and
  routing `addPlan/updatePlan/removePlan` through the API (like `commands.ts` already does for mode).
- **Backend contract** (all under `http://<host>:8080`) is below and matches your `store.ts` shapes.

---

## Backend contract (stable — build against these)

### Plans — per loadpoint (`chargerId` == loadpoint name)

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/loadpoints/:name/plans` | — | `PlanDto[]` |
| `POST` | `/api/loadpoints/:name/plans` | `{ days, readyBy, target, unit, enabled? }` | `201 PlanDto` |
| `PUT` | `/api/loadpoints/:name/plans/:id` | partial (any of the above) | `200 PlanDto` |
| `DELETE` | `/api/loadpoints/:name/plans/:id` | — | `204` |

```ts
interface PlanDto {
  id: string            // stringified rowid — matches your Plan.id: string
  loadpointName: string // → your Plan.chargerId
  days: DayKey[]        // "mon".."sun" — same DAY_KEYS order as src/ui2/src/lib/format.ts
  readyBy: string       // "HH:MM" (site-local)
  target: number
  unit: "pct" | "km" | "kwh"
  enabled: boolean
  resolvedSoc: number | null // backend display %: pct→value, km→via car ratio, kwh / no-car → null
}
```

- **400** on: empty/unknown `days`, `readyBy` not `HH:MM`, `unit` not `pct|km|kwh`, `target ≤ 0`, or
  `pct` target > 100. **404** if the loadpoint (or plan id under it) doesn't exist.
- **SSE `loadpoint.plans` `{ name }`** fires on every create/update/delete → re-fetch that loadpoint's plans.
- Send `km` as `{ unit: "km", target: <km> }` — the backend converts km→% for **both** charging and
  display. Read **`resolvedSoc`** off each `PlanDto` for the ring / "≈N%"; do **not** recompute km→%
  client-side (the old guidance — it caused a hardcoded constant + wrong-vehicle drift). Keep the raw
  target ("300 km by 07:00") as the headline, `resolvedSoc` as the "≈N%". It's `null` for kwh targets
  and when there's no car → then show the raw target only, no ring arc.

### Settings — site timezone

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/settings` | — | `{ timezone: string }` |
| `PUT` | `/api/settings` | `{ timezone: string }` (IANA) | `200 { timezone }` / `400` |

- **SSE `settings.changed` `{ timezone }`** on change.
- In **setup**, detect the browser tz and persist it: `PUT /api/settings { timezone:
  Intl.DateTimeFormat().resolvedOptions().timeZone }`.

### minSoc — per loadpoint

- `POST /api/loadpoints/:name/target` now accepts an optional `minSoc` (0–100) alongside `{ soc, time, kwh }`
  (all COALESCE-merged — send only what changed).
- Surfaced on `GET /api/loadpoints` as `minSoc` (camelCase, on `LoadpointStateDto`) and on the
  **`loadpoint.target`** SSE event (add `minSoc?` next to the `targetKWh?` you already read).

### availableTargetUnits — per loadpoint

- `GET /api/loadpoints` now includes **`availableTargetUnits: ("pct"|"km"|"kwh")[]`** on each loadpoint —
  the units its data sources can actually back right now: `kwh` always; `pct` when SoC + battery capacity
  are known; `km` also needs range. **Gate the plan-editor unit picker on this list.**
- Derived from the bound vehicle's cached reading, so it grows once a car is seen (`["kwh"]` →
  `["pct","km","kwh"]`). Re-read it when you re-fetch loadpoints (e.g. on `loadpoint.state`) — there's no
  dedicated SSE event; best-effort is fine.

---

## Wiring TODO (ui2 side)

> **Status: done** — all items below were wired on `feat/ocpp-zaptec-charging` (ui2 auto-detects the
> backend; plans/timezone/minSoc are read on startup, mutated via the optimistic + `isLive()` command
> seam, and reconciled over SSE). The day-aware active-plan resolver lives in `src/ui2/src/lib/plan.ts`.
> The mock (`scripts/mock-backend.mjs`) implements the same endpoints so demo mode exercises them.
> Kept as reference for the contract. No backend changes were made.

1. **`src/ui2/src/lib/api/rest.ts`** — add client methods (mirror `setMode`/`setProfile`):
   `getPlans(name)`, `createPlan(name, body)`, `updatePlan(name, id, patch)`, `deletePlan(name, id)`;
   `getSettings()`, `setSettings({timezone})`. Add `minSoc?` to `LoadpointStateDto` + `setTarget`'s body.
2. **`src/ui2/src/lib/live/map.ts`** — add `mapPlan(dto: PlanDto): Plan` (`loadpointName`→`chargerId`;
   `id`, `days`, `readyBy`, `target`, `unit`, `enabled` pass through). In `mapLoadpoint`, also read `minSoc`.
3. **`src/ui2/src/lib/mock/store.ts`** — `hydrate` is currently `Pick<…,"chargers"|…>` and excludes
   `plans`; add `plans` (or a `setPlans`) so live data can populate them.
4. **`src/ui2/src/lib/live/commands.ts`** — add `addPlan/updatePlan/removePlan` command wrappers using the
   existing pattern (optimistic local mutation + `if (isLive()) await api.…`). Point the `PlanRow` editor +
   "Add plan"/delete at these instead of the raw zustand actions, so demo mode still works locally.
5. **`src/ui2/src/lib/live/useLiveSync.ts`** —
   - after hydrating chargers, `getPlans(name)` per loadpoint → hydrate `plans` (today the header comment
     notes plans are intentionally skipped — that's the line to change).
   - add `subscribe("loadpoint.plans", …)` → re-fetch that loadpoint's plans.
   - add `subscribe("settings.changed", …)` → update the site timezone in the store (if you surface it).
   - extend the existing `subscribe("loadpoint.target", …)` to also read `minSoc`.
   - optionally `getSettings()` on startup to seed the timezone.
6. **Active-plan display** (`ChargerCard`/`HeroStatus`/`ChargerDetail`) — your mock picks "first enabled
   plan". For a summary that matches what the backend actually charges to, mirror the resolution rule
   below (day-aware); or leave the summary simple and trust the backend for charging.

---

## Resolution rule (what the backend actually charges to)

Among **enabled** plans whose `days` include **today** (site timezone) with a **`readyBy` still later
today**, the **earliest `readyBy`** governs. If none qualifies (wrong day, all passed, or zero plans),
the loadpoint's ad-hoc `targetSoc`/`targetKWh` is the fallback ("just charge when plugged in"). This is
the backend's contract; your day toggles + ready-by feed straight into it.

---

## Gotchas

- **The DB is the runtime source of truth.** Mode/targets/minSoc/plans set via the API persist and win
  over `osc.yaml` on restart. Config only *seeds* defaults; `npm run config:apply` re-asserts the file.
  So a plan created in the UI survives a reboot — good.
- **Plans + settings are runtime tables, not config.** There's no `osc.yaml` plans list by design.
- **Two timezones.** You only ever touch the **site** timezone (`/api/settings`). Tariff providers use
  their own market tz internally — not your concern.
- **ids are strings** in the DTO (stringified rowids). Your `Plan.id: string` already matches.
- **km needs a connected car** — without one the backend can't convert km→%, so a km plan's
  `resolvedSoc` is `null` and `km` is absent from `availableTargetUnits`. Your "km targets need a
  connected car" note is still the right UX.
- **Don't recompute km→% or the target ring client-side** — read `resolvedSoc` per plan and gate the
  unit picker on `availableTargetUnits`. The backend owns the range/soc ratio + battery capacity; the UI
  just displays. (This retires the hardcoded efficiency constant + the fake-80% ring.)

---

## Running against the live backend

```bash
npm run dev            # backend on :8080 (serves all the endpoints above)
npm run dev:ui2        # ui2 dev server; set OSC_BACKEND=http://localhost:8080 if the proxy needs it
```

`useLiveSync` auto-probes `GET /api/loadpoints`: reachable → **live** (hydrate + SSE), unreachable →
**demo** (local mock tick). So partial wiring is safe — unwired slices just stay on their mock values.
If you extend `scripts/mock-backend.mjs`, add the `/plans` + `/settings` routes there too so demo mode
exercises the same shapes — **include `resolvedSoc` on each plan and `availableTargetUnits` on each
loadpoint** (mirror the backend: `pct`→value, `km`→`value ÷ (range/soc)`, `kwh`/no-car→`null`; units =
`kwh` always, `pct` with soc+capacity, `km` also with range) so demo mode matches live.
