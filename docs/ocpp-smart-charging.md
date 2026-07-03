# OCPP smart charging — how OSC controls current, and the quirks that will bite you

This doc explains how OSC sets a charger's charging current over OCPP 1.6J, the
non-obvious behaviours we hit bringing up a real **Zaptec Go** (native/box-level
OCPP), how to diagnose them, and what we'd do to find such issues faster next time.

If a charger accepts your commands but **won't deliver power** (`SuspendedEVSE`,
`Current.Offered: 0`), read the [Quirks](#quirks-that-will-bite-you) and
[Debugging playbook](#debugging-playbook) — that exact scenario cost us a long
session and has a simple root cause.

## How OSC sets the charge current

OSC controls current with a single OCPP `SetChargingProfile`
(`src/modules/charger-ocpp16/commands.ts` → `buildChargingProfilePayload`, sent via
`server.ts` → `setLimit`):

- **`chargingProfilePurpose: TxDefaultProfile`** — applies to the connector whether or
  not a transaction is active (so we can set the limit before/around `RemoteStart`).
- **`chargingRateUnit: 'A'`** (amps). Required on Zaptec Go/Go2 — they only accept
  `Current`, not `Power`.
- **connector `1`** (the physical connector), **not** connector `0`. TxDefaultProfile on
  connector 0 is charge-point-wide; some chargers won't apply it to the active
  connector's session. (evcc also sends on the connector id.)
- **`chargingProfileKind: 'Absolute'`** with **`startSchedule` backdated ~60 s**, so the
  single period at `startPeriod: 0` is already active regardless of clock skew. A
  start time of "now" can make a charger treat the limit as "not started yet" → 0 A.
- One period: `{ startPeriod: 0, limit: <amps>, numberPhases: 3 }`.
- Writes are **debounced** (`minWriteIntervalSec`, default 10 s; `debounce.ts`) and the
  amps are **clamped to `[0, maxA]`** (`index.ts`). A **6 A boot default** is pushed on
  `BootNotification` so the charger is never at an unknown limit.

Outbound commands OSC can send (all in `commands.ts`, wired through `server.ts` →
`index.ts` → `src/server/api.ts`): `SetChargingProfile`, `RemoteStartTransaction`,
`RemoteStopTransaction`, `Reset`, `ChangeAvailability`, `ClearChargingProfile`,
`GetCompositeSchedule`.

## Reading the charger's actual state

- **`Current.Offered`** (a `MeterValues` measurand) = the amps the charger is *offering*
  right now. `0` here means the charger is withholding, regardless of what profile you
  sent.
- **`GetCompositeSchedule`** = the charger's *effective* computed limit after combining
  all active profiles. **This is the single most useful diagnostic** — it tells you what
  the charger actually thinks the limit is, which can differ from the profile you sent.
- **Status**: `Available` (idle) → `Preparing` (plugged, no tx) → `Charging` →
  `SuspendedEVSE` (charger withholding, e.g. 0 A offered) / `SuspendedEV` (car not
  drawing) → `Finishing`.

## Quirks that will bite you

1. **Charging profiles are *stacked*; the highest `stackLevel` wins.** A profile at a
   higher stack level overrides yours completely — even one left by a *different* central
   system. This is the big one.
2. **Profiles persist on the charger across central-system reconnects.** When you take
   over a charger that another CS (e.g. evcc) was driving, **its profiles are still
   installed.** In particular, evcc's "Off"/disable sends a **0 A `TxDefaultProfile` at
   the charger's max stack level** (native Zaptec: up to **8**). If your CS then installs
   at a *lower* stack level, that leftover 0 A profile keeps winning → `Current.Offered: 0`.
3. **"Accepted" ≠ "applied".** `SetChargingProfile` returns `Accepted` even when a
   higher-stack profile is overriding it. Don't trust the ack — verify with
   `GetCompositeSchedule`.
4. **Native (box-level) and Cloud OCPP report different capabilities.** The **cloud** docs
   say `ChargeProfileMaxStackLevel = 1` and `MaxChargingProfilesInstalled = 1`; **native**
   is up to `8` / `24`. Reading the cloud doc misled us into thinking stack level was
   irrelevant. **Always read the box-level/native docs for a directly-connected charger.**
5. **`SuspendedEVSE` + `Current.Offered: 0` = the charger is offering 0 A.** It's not the
   car (that would be `SuspendedEV`), and it's not "not started". Go straight to
   `GetCompositeSchedule`.
6. **Zaptec can get stuck in `SuspendedEVSE`.** Once a session starts while effectively
   0 A, a later non-zero limit may be ignored until a **fresh session** (unplug/replug) or
   a **Soft `Reset`**. Set a valid limit *before* the transaction starts.
7. **Unit must be amps (`A`)** on Zaptec Go/Go2.
8. **Old firmware has profile/`SuspendedEVSE` bugs.** Native FW < 2.5.x had fixes for
   "transaction start in SuspendedEVSE" and incorrect profile application — check the
   charger's firmware version if behaviour is strange.

## Debugging playbook

When a charger accepts profiles but won't charge:

1. **Turn on raw OCPP frame logging** early. `server.ts` has a `client.on('message', …)`
   logger (currently temporary; keep it behind a debug flag). It prints every inbound/
   outbound frame — invaluable, and we added it far too late.
2. **Ask the charger what limit it's actually using:**
   `GET /api/loadpoints/<name>/composite-schedule?duration=60`. If the reported
   `limit` is `0` (or below your value) while your `SetChargingProfile` was `Accepted`,
   a **higher-stack / leftover profile is overriding you** (Quirks 1–2).
3. **Reset the profile stack:** `POST /api/loadpoints/<name>/clear-profile`
   (`ClearChargingProfile`, no filter → clears all). Re-check `GetCompositeSchedule`:
   after clearing, ours should win. ⚠️ **After a clear the charger reverts to its
   hardware default (e.g. 32 A)** — never auto-clear during an active charge, or you can
   briefly exceed the circuit limit. Clear only when idle, then set your profile.
4. **Set your limit, verify, then start:** `POST …/profile {"amps":N}` →
   `GET …/composite-schedule` shows `N` → `POST …/start` → watch `MeterValues` for real
   `Current.Import` on all phases (not just status `Charging`).
5. If it's still stuck, **Soft `Reset`** the charger (`POST …/reset {"type":"Soft"}`) for a
   clean state, and **check firmware**.

## The incident (2026-07-03)

Real Zaptec Go, driven by OSC over native OCPP 1.6J. Every attempt stuck at
`SuspendedEVSE` / `Current.Offered: 0` although `SetChargingProfile` (10 A), `RemoteStart`,
and `StartTransaction` all succeeded. The identical charger charged fine on evcc; the
user had charged via evcc, hit **"Off"**, then only swapped the WebSocket to OSC.

**Root cause:** evcc's "Off" left a **0 A `TxDefaultProfile` at stack level 8** on the
charger; native Zaptec persists it across the CS swap. OSC installed at hardcoded
`stackLevel: 1`, so evcc's 0 A profile kept winning. `GetCompositeSchedule` confirmed the
effective limit was `0`. `ClearChargingProfile` → composite jumped to the 32 A default →
our 10 A profile then won (composite 10) → `RemoteStart` → **Charging, 6.6 kW, ~9.5 A/phase**.

## Retrospective — how to find this faster next time

1. **When `Current.Offered: 0` with an Accepted profile, call `GetCompositeSchedule`
   immediately.** It shows the *effective* limit and would have pointed straight at an
   override on minute one.
2. **Enable raw OCPP frame logging from the start** of any hardware bring-up.
3. **Read the native/box-level charger docs, not the cloud ones** — capabilities differ.
4. **Assume leftover state** from any previous central system; a charger is not a clean
   slate on takeover. Check/clear its profile stack.
5. **Never equate `Accepted` with `applied`** — verify the effect, not the ack.

## References
- Zaptec native OCPP 1.6J docs & release notes: <https://docs.zaptec.com/docs/ocpp16j>,
  <https://docs.zaptec.com/changelog/zaptec-go-ocpp-native-release-notes>,
  <https://docs.zaptec.com/docs/zaptec-ocpp16j-compliance-faq>
- evcc generic OCPP charger (reference implementation): `.references/evcc/charger/ocpp/`
- OSC charger module: `src/modules/charger-ocpp16/`
