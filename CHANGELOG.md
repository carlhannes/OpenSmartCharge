# Changelog

All notable changes to OpenSmartCharge are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

A cleanup pass against the project's own principles (single source of truth, lean, evergreen docs),
driven by a full audit of core, SDK, modules, server, UI, scripts and docs. Control-loop behaviour is
unchanged except where a user-facing bug is listed under Fixed.

### Fixed

- **Fresh installs no longer boot-loop from the example config.** `osc.dist.yaml` still carried the
  retired top-level `mqtt:` block (silently ignored) and a meter reader without the now-required
  `broker:` — which threw at startup and, because the config had already been imported into the
  database, crashed every restart. The template now uses `mqttBridge:` and a `broker:` block, and
  its stale per-vehicle poll knobs and reversed tariff-health comment are gone.
- **Scheduled day-ahead price refreshes aborted themselves.** The jittered `ctx.fetch` slept up to
  120 s *after* the provider had created its 15 s `AbortSignal.timeout`, so most scheduled fetches
  failed on arrival (the likely cause of the "tariff is empty" known issue). The herd-spreading jitter
  now lives in the fetch *schedule*; requests use the plain global `fetch`.
- `npm run smoke` could not pass: it wrote the retired `mqtt:` block and reused a stale data directory
  (the config is imported only once). It now writes `mqttBridge:` and starts from a clean directory.
- API: a request without a JSON body returned a 500 (Express 5 leaves `req.body` undefined); unknown
  `/api/*` paths returned the SPA shell with a 200. Both are now proper 4xx JSON responses.
- MQTT bridge: `osc/health/<module>` was published only at connect and never updated; `cmd/target`
  accepted out-of-range values the REST route rejects (one shared validator now); the mode topic was
  published twice per change; a tariff whose `prices()` rejected would have crashed the process.
- UI: the charger max-amps field saved on every keystroke (typing "16" first persisted — and commanded
  — 1 A); it now commits on blur/Enter and rejects values outside 6–32 A. Charger rename / max-amps
  and the "charger offline" banner used the loadpoint name where the backend keys by charger name.
  The main-breaker setting wrote `site.mainBreakerA`, which a balancer circuit never reads — it now
  edits (and shows) the balancer's breaker when there is one.
- **One broken module no longer takes OSC down.** A module whose setup throws (e.g. a meter reader
  without `broker:`) is logged, shown as `unavailable` and skipped; everything else boots and the
  control loop degrades around it. A circuit whose balancer is missing is held at 0 A (fail closed:
  there is no safe split without it) and logged once. An error inside a control tick is logged instead
  of crashing the process.
- **The balancer could allocate more than the circuit budget.** Its 1 A hysteresis held the previous,
  higher value when the budget dropped. It now only holds a value on a small *rise*.
- **With two or more chargers, an idle one made the other's car be polled every 30 s** (and reset its
  failure backoff), risking a car-API lockout. The poll state now resets only when that charger is
  unplugged, and never for a car another charger is using.
- Smart-mode planning used the balancer's phase count (default 3) even for a 1-phase charger, so it
  planned too few slots. It now uses the lower of the charger's and the supply's phases.
- MySkoda requests had no timeout; a car-side start-charge is awaited inside the control tick, so a
  hung request could freeze current control for that circuit. Every call now times out after 15 s.
- Day-ahead prices: a failed slot write could leave a database transaction open for the whole app
  (later writes uncommitted and lost on exit). It now rolls back. A replaced tariff could keep
  fetching forever, its health only updated on fetch attempts (now derived live), and a dead
  internet link could delay boot by up to ~45 s (the first fetch no longer blocks startup). A fetch
  that fails before the 13:15 window now retries with the same backoff instead of waiting for the
  window — a fresh install hit by a blip had no prices at all until then.
- DST: on a host with a DST timezone, the autumn change produced one 75-minute plan slot (and a
  2-hour flat-tariff slot), and "tomorrow at 07:00" landed an hour off on DST nights. A target within
  an hour of the change itself (01:30 on either DST night) now lands on the right side of it as well.
- OCPP: power reported in kW was shown 1000× too small, a sample without a measurand (the energy
  register by default — when its unit agrees) was ignored, and a session closed after a missed StopTransaction got an end
  time the UI read as local time.
- Home Assistant's "Session energy" sensor dropped to zero on OCPP transaction churn mid-session, so
  HA over-counted energy; it now reports the per-plug-in delivered total.
- Charger health appeared a second time under the loadpoint's name after any mode change.
- `PUT /api/mqtt-bridge` persisted the redacted password placeholder when a client echoed it back;
  `GET /api/transactions?limit=-1` returned every row and a non-numeric limit returned a 500 (an
  empty `?limit=` now means the default 50).
- `HH:MM` inputs (ad-hoc targets, plan ready-by times, config `targetTime`) are validated as a real
  wall-clock time; `99:99` or `24:01` used to be accepted and silently rolled into the next day(s).
  `24:00` is still accepted as end-of-day midnight.
- An async plugin registered after modules were created, so its types were reported as unknown.
- `npm run restore` without `--in` crashed instead of printing its usage (and a missing data directory
  was a stack trace); backup and restore now honour `OSC_DATA_DIR`, and a forced restore removes the
  old database's stale WAL files.
- Docs that sent users down a broken path: the dev quick-start lacked the UI's own `npm install`,
  the runtime-configuration section described a `config:apply --prune` that doesn't exist, the
  config reference claimed a boot warning for `mqtt:` that never fired, and its multi-grid example
  used Elering for Swedish zones with meter readers that would not start.

### Removed

- **`ModuleCtx.fetch`** (the jittered fetch) — see Fixed above for why. Modules call the global
  `fetch` with a per-request timeout; timing concerns belong to the schedule. No first-party module
  used it after the fix and there are no external plugins, so this is a clean pre-1.0 SDK change.
- `MeterReader.onSnapshot()` — every consumer already listened to the `meter.snapshot` bus event.
- Dead code: `loadConfig`, `applyConfigSettings`, `msUntilLocalMidnight`, `autoIdentifiable`, the
  unused `src/sdk/index.ts` barrel, the `SmartChargingConfig`/`Logger` aliases, an unread OCPP
  `statusCallbacks` field, unused UI client helpers, React Query (installed and provided, never used),
  the `build:server` script (which would have shipped tests into `dist/`), and the finished ui2
  hand-off docs (their still-true API notes moved into `docs/config.md`).

### Changed

- Shared helpers consolidated in the SDK (one source each): `connectBroker`/`endBroker`,
  `meterHealth`, `nextLocalTime`, `inLocalHourWindow` (was `isNight`), `IEC_MIN_CURRENT_A`,
  `DEFAULT_TIMEZONE`, `DEFAULT_LOG_RETENTION_DAYS`, the Nord Pool `MARKET_TZ`/`FETCH_TIMEOUT_MS`, and
  the retry backoff. `electrical.ts` and `source-reconciler.ts` moved from `core/` to `sdk/` so the
  Škoda module no longer imports from core (the one boundary violation).
- `npm run lint` / `npm run format` now cover `src/ui2` as well; a `.dockerignore` keeps `data/`,
  `osc.yaml` and `node_modules` out of the image, and the runtime image carries production
  dependencies only.
- Docs brought back in line with the code: AGENTS.md (five module types, `src/ui2`, `mqttBridge`,
  the site timezone, the honest Nord Pool timer exception), the module authoring guide (Vehicle,
  Balancer, MeterReader and `ModuleCtx` contracts), the architecture overview, the config reference,
  the roadmap, and the known-issues log (resolved entries removed). `docs/vision-0.2.0.md` is kept
  as the product reference for Parts 1–6 and marked historical.

## [0.2.2] — 2026-07-25

A batch of fixes and missing edit affordances found while running v0.2.1 on a real VM. These are
about settings honesty and editability — the charging control loop is unchanged.

### Added

- **Editable house & load-balancing settings** (Settings → House): the main breaker and the
  safe-fallback margins (night margin, daytime fraction) that set the current cap when there is no
  live meter reading. Backed by the existing `PUT /api/site` and `PUT /api/smartcharging`; applied
  live (no restart).
- **Home / installation name** — editable in Settings → House and shown on Settings → About. It
  persists to config backups and Home Assistant discovery (`PUT /api/site {name}`, already supported).
- **Car display label (rename)** — a cosmetic per-vehicle label, mirroring chargers. Rename inline in
  Settings → Vehicles; the internal vehicle name stays the identity key. `PUT /api/vehicles/:name`
  now accepts `label`, and it is exposed on `GET /api/site` (falling back to the name).
- **The "why" behind the current limit** — the charger detail now shows which rung the control loop
  is on: balancing on a live meter, historical worst-case, or the safe time-of-day fallback (from the
  backend's `resolve.sources.current`). Directly answers "is load balancing even active?".
- **Module type on the System status page** — each row shows its kind (charger / meter / vehicle /
  tariff / balancer), so "house", "home" and "garage" are finally distinguishable.

### Changed

- **Config import defaults to `merge`** (was `replace`). Replace — which wipes the existing config
  first — is now an explicit, warned opt-in. Replace-by-default had nuked a live configuration.
- **"Reset all data" is now real.** It was a client-only store reset that never touched the backend.
  It now calls `POST /api/system/reset`, which wipes the entire database (config, plans, sessions,
  meter history, caches) and restarts; on reboot your `osc.yaml` re-materializes (or you land in
  onboarding if you keep none). Two-step confirm, with the same supervised-restart handling as manual
  restart.
- **App version is single-sourced** from the root `package.json`. It had been hardcoded and drifted
  to a wrong "0.3.0" in the About screen and footer.
- **A metered site is no longer mislabeled "static".** The meter source now reflects the actual
  configured reader (Tibber Pulse / MQTT / none) instead of assuming "static" whenever no balancer
  was present.

### Notes

- Charger **rename** and **max-amps** are live-editable. Charger **delete** and **pending-claim** from
  the Settings page in live mode remain a roadmap item — deleting a charger is a destructive config
  mutation, and claiming a new charger already lives in the onboarding flow.
- The VM's "no load-balancing data / stuck static" symptom was environmental (its MQTT meter broker
  was unreachable, so OSC correctly degraded to the safe fallback). These changes make that state
  **visible and honest**; live data flows once the broker is reachable.

## [0.2.1] — 2026-07-25

### Fixed

- OCPP server now always starts at boot, so a fresh install accepts chargers without first having to
  create one via the API.
- Copy-to-clipboard falls back gracefully in non-secure contexts (plain http on a LAN IP), where the
  `navigator.clipboard` API is unavailable.
- Installer time-sync is resilient when `systemd-timesyncd` is absent (as on some minimal VMs).

### Added (the 0.2.x line leading to 0.2.1)

- ui2 is the production UI, built and served by the backend.
- A `setup.sh` installer; OSC runs as a dedicated unprivileged `osc` user under a hardened systemd
  unit with `Restart=always`.
- A fully live onboarding wizard, with "import a backup" at the welcome step.
- Real config backup/restore (export/import an `osc.yaml`) and a graceful `POST /api/system/restart`.

[0.2.2]: https://github.com/carlhannes/OpenSmartCharge/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/carlhannes/OpenSmartCharge/releases/tag/v0.2.1
