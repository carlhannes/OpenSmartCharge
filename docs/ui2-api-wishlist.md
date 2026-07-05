# ui2 → backend API wishlist — ✅ shipped

**For the agent working on `src/ui2/`.** Everything on this list is now **implemented** on
`feat/ocpp-zaptec-charging`. The controls ui2 renders read-only ("set in osc.yaml") can be un-locked —
each maps to a write endpoint below. Every write persists to the DB (`config_overrides`, persist-wins)
and is applied at runtime by the **declarative reconcile seam** — no restart. All emit a
**`config.changed`** SSE (forwarded on the `*` wildcard, like `settings.changed`), so open clients
reconcile by re-fetching `GET /api/site`.

Design note: rather than the suggested "scalar in the settings KV + live-read," the backend uses one
`config_overrides` table (JSON patches over the parsed `osc.yaml`, re-validated by the same schema) + a
reconcile step that **soft-reloads the affected module**. A KV of scalars can't express *new* entities
(claimed chargers / added vehicles); one patch table does both, and modules are safe to rebuild (durable
state in SQLite, desired state re-derived each tick, observed state re-reported on reconnect — see
AGENTS.md → "Declarative config & soft-reload").

---

## 1. Runtime site knobs — region + main breaker ✅
- **Main breaker:** `PUT /api/site { mainBreakerA }`.
- **Tariff region/zone:** `PUT /api/tariffs/:name { zone }` — reloads the tariff module, which re-fetches
  the new zone (brief gap degrades to the price fallback + self-heals).
- Both reflected live in `GET /api/site`. Implemented as **per-entity endpoints**, not a widened
  `/api/settings`, because the breaker is site-level and the zone is per-tariff — cleaner + multi-entity-safe.

## 2. Balancer settings ✅
`PUT /api/balancers/:name { mainBreakerA, phases, nightMarginA, daytimeFraction }`
(partial — send only what changed; reloads the balancer module). The old flat `safeStaticCurrentA` /
`meterStaleAfterSec` / `intervalSec` are gone: the balancer is now a pure splitter, the meter (and its
staleness) lives on a `meterReader`, and `nightMarginA`/`daytimeFraction` are the per-breaker static-tod
fallback margins. **Type/source change is not a field edit** (it's a different module) — model it as
remove + re-add; not wired as a single call.

## 3. Charger management ✅
- `GET /api/chargers/pending` → stations connected over OCPP but unclaimed
  (`{ stationId, vendor, model, status, connectedAt }`) — the real "waiting for charger… → claim" flow.
- `POST /api/chargers { stationId, name, maxA?, phases?, tariff?, balancer?, vehicle? }` — claims it:
  creates the charger **and** its loadpoint (name == charger name), registers the station, wires it live;
  the already-open socket becomes controllable immediately (the next tick commands it).
- `PUT /api/chargers/:name { label?, maxA? }` — rename is a cosmetic `label` (identity/`stationId` immutable —
  a true key-rename would rewrite loadpoint refs + `transactions` rows for no functional gain).
- `DELETE /api/chargers/:name` — removes the charger + its loadpoint; the socket reverts to pending.
- **Safety fix:** an unclaimed connected charger now defaults `autoStart: false` — OSC won't start a
  session on a charger it doesn't manage yet.

## 4. Vehicle management ✅
- `POST /api/vehicles { name, type:"skoda", username, password, vin }` — returns 201 immediately; auth +
  first fetch run in the background (poll `GET /api/vehicles/:name`). Credentials are stored server-side
  and **never returned or logged**; `GET /api/site` stays whitelisted to `{ name, type, vin }`.
- `DELETE /api/vehicles/:name` — teardown + drops `vehicle_cache`; a bound loadpoint degrades to no-SoC.
- **Bind to a loadpoint:** `PUT /api/loadpoints/:name { vehicle }` (also `tariff`/`balancer`; the ref must exist).
- Security: creds move from `osc.yaml` (plaintext, gitignored) to `config_overrides` in `data/osc.db` —
  same plaintext-at-rest posture; `chmod 700 data/`. Encryption-at-rest is a noted future item.

## 5. Config-change SSE ✅
`config.changed { kind, name }` fires on every reconcile (site/tariff/balancer/charger/vehicle/loadpoint).
No new SSE plumbing — it rides the existing `*` wildcard → `/events`. Re-fetch `GET /api/site` on it.

## 6. `GET /api/site` consistency ✅
- `site.timezone` now returns the **runtime** value (`getTimezone`), matching `GET /api/settings`.
- `loadpoints[].{ targetSoc, targetTime, targetKWh, maxCurrentA, autoStart, minSoc }` now come from the
  **live** `LoadpointState`, not config seeds.
- Structural fields (chargers/balancers/tariffs/vehicles, incl. runtime-added ones) reflect the effective
  config automatically.

## 7. Resolved plan target % ✅
Shipped in the target-model rework — `PlanDto.resolvedSoc` + `availableTargetUnits`. See
`docs/ui2-backend-handoff.md`.

---

## Persistence & reset (for the UI's mental model)
- Writes persist in `config_overrides` (DB wins over `osc.yaml`) and survive restart.
- `npm run config:apply` re-asserts `osc.yaml`: it **clears** overrides for entities the file defines
  (region/breaker/etc. revert to the file) and **preserves** runtime-added entities (claimed chargers /
  added vehicles). `npm run config:apply -- --prune` clears everything (DB == file).
- A charger/vehicle `DELETE` removes its override (gone for good). A charger *defined in `osc.yaml`*
  returns on the next reboot (the file is its source of truth).

## Un-locking a control in ui2
Same shape as the `timezone`/mode controls you already wired: add a `commands.ts` wrapper (optimistic
local + `if (isLive()) await api.…`), drop the `disabled`/`ConfigLockNote` gate, and re-fetch on
`config.changed`. If you extend `scripts/mock-backend.mjs`, add these routes there too for demo mode.

---

## One follow-up found while wiring — charger `label` isn't observable
`PUT /api/chargers/:name { label }` accepts a rename, but no read endpoint surfaces it:
`GET /api/site.chargers[]` is `{ name, type, stationId, maxA }` and `GET /api/loadpoints[]` has no
display-name field — both return only the immutable `name`. So the UI can't display or reconcile a
rename (it would flash locally then revert on the next `config.changed`), and we've kept the charger
**name field read-only** for now. To make rename usable, please surface `label` on the charger DTO (e.g.
`GET /api/site.chargers[].label`, falling back to `name`). Everything else on this list is wired
(Phase 1: region + breaker + charger maxA; the rest queued behind their flows).
