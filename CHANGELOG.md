# Changelog

All notable changes to OpenSmartCharge are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
