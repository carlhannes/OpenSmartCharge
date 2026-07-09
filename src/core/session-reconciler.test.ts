import { test, expect } from 'vitest'
import {
  decideSession,
  type SessionInput,
  type SessionReconcilerState,
  type SessionReconcilerCfg,
} from './session-reconciler.js'

// The SessionReconciler's pure decision core. It is the recovery brain — every failure mode that
// stranded the car overnight must resolve to a bounded, guarded ladder of actions here. Tests drive
// it tick-by-tick with an explicit `now` (no clocks) and assert the action + the guard bookkeeping.

const cfg: SessionReconcilerCfg = {
  minDrawA: 1,
  graceMs: 90_000,
  cooldownMs: 180_000,
  maxActions: 6,
}

const fresh: SessionReconcilerState = { phaseAttempts: 0, totalActions: 0 }

// A fully-capable rig (vehicle can wake, charger can start/clear/reset), wants charge, drawing ~0.
function input(over: Partial<SessionInput> = {}): SessionInput {
  return {
    wantsCharge: true,
    status: 'SuspendedEV',
    drawingA: 0,
    carPluggedIn: true,
    carCharging: false,
    vehicleCanActuate: true,
    chargerCanRemoteStart: true,
    chargerCanClearProfile: true,
    chargerCanReset: true,
    now: 0,
    ...over,
  }
}

test('healthy states reset the episode: drawing, not-wanting, or genuinely idle → no action', () => {
  const mid: SessionReconcilerState = {
    stalledSinceMs: 0,
    lastActionMs: 100_000,
    phaseAttempts: 2,
    totalActions: 3,
    phase: 'session-open',
  }
  // Drawing again → episode resets to fresh.
  const drawing = decideSession(mid, input({ drawingA: 8, now: 200_000 }), cfg)
  expect(drawing.action.kind).toBe('none')
  expect(drawing.next).toEqual(fresh)
  // OSC no longer wants charge (paused at target / disabled) → reset.
  expect(decideSession(mid, input({ wantsCharge: false, now: 200_000 }), cfg).next).toEqual(fresh)
  // Genuinely idle: connector Available AND the car isn't plugged → nothing to charge → reset.
  expect(
    decideSession(mid, input({ status: 'Available', carPluggedIn: false, now: 200_000 }), cfg).next,
  ).toEqual(fresh)
})

test('grace absorbs the normal ramp — no action until graceMs of continuous stall', () => {
  // First stalled tick records stalledSince but does not act.
  let r = decideSession(fresh, input({ status: 'Preparing', carCharging: undefined, now: 0 }), cfg)
  expect(r.action.kind).toBe('none')
  expect(r.next.stalledSinceMs).toBe(0)
  // Still within grace.
  r = decideSession(
    r.next,
    input({ status: 'Preparing', carCharging: undefined, now: 60_000 }),
    cfg,
  )
  expect(r.action.kind).toBe('none')
})

test('no-session (Preparing) past grace → RemoteStart; then a phase flip to a held session picks wake-car', () => {
  // Past grace, no open transaction → open one.
  let r = decideSession(
    { ...fresh, stalledSinceMs: 0 },
    input({ status: 'Preparing', carCharging: undefined, now: 100_000 }),
    cfg,
  )
  expect(r.action.kind).toBe('remote-start')
  expect(r.next).toMatchObject({ phase: 'no-session', phaseAttempts: 1, totalActions: 1 })

  // Within cooldown of that action → hold.
  expect(
    decideSession(r.next, input({ status: 'Preparing', carCharging: undefined, now: 150_000 }), cfg)
      .action.kind,
  ).toBe('none')

  // Past cooldown, the session is now OPEN but the car reports charging OFF (chargeMode OFF): the
  // phase flipped no-session→session-open, so the ladder RESETS and picks the car-side wake first
  // (the exact overnight fix) — not wherever the no-session ladder had advanced to.
  r = decideSession(r.next, input({ status: 'SuspendedEV', carCharging: false, now: 300_000 }), cfg)
  expect(r.action.kind).toBe('wake-car')
  expect(r.next).toMatchObject({ phase: 'session-open', phaseAttempts: 1, totalActions: 2 })
})

test('session-open ladder ordering keys off the car signal', () => {
  const base = { status: 'SuspendedEV' as const, now: 100_000 }
  // Car says NOT charging → wake first, then a fresh transaction.
  let r = decideSession(
    { ...fresh, stalledSinceMs: 0 },
    input({ ...base, carCharging: false }),
    cfg,
  )
  expect(r.action.kind).toBe('wake-car')
  r = decideSession(
    { ...r.next, lastActionMs: undefined }, // ignore cooldown for this ordering check
    input({ ...base, carCharging: false, now: 100_000 }),
    cfg,
  )
  expect(r.action.kind).toBe('resume')

  // Car's charging signal UNKNOWN (no/failed telemetry) but 0 A at the EVSE → a SuspendedEV latch is
  // likelier, so open a fresh transaction first, keeping the car-side wake as a fallback rung. (A car
  // reporting it IS charging never reaches the ladder — it resets the episode; covered separately.)
  let r2 = decideSession(
    { ...fresh, stalledSinceMs: 0 },
    input({ ...base, carCharging: undefined }),
    cfg,
  )
  expect(r2.action.kind).toBe('resume')
  r2 = decideSession(
    { ...r2.next, lastActionMs: undefined },
    input({ ...base, carCharging: undefined, now: 100_000 }),
    cfg,
  )
  expect(r2.action.kind).toBe('wake-car')
})

test('trusts the car: reports charging (near-full taper) or at its own ceiling → no recovery', () => {
  const after = { ...fresh, stalledSinceMs: 0 }
  // Car reports CHARGING but draw is below minDrawA (a near-full taper) → trust it, reset the episode
  // rather than interrupting a legitimate slow finish.
  const tapering = decideSession(
    after,
    input({ status: 'SuspendedEV', carCharging: true, drawingA: 0.4, now: 100_000 }),
    cfg,
  )
  expect(tapering.action.kind).toBe('none')
  expect(tapering.next).toEqual(fresh)
  // Car at its OWN care ceiling (fast mode still commands current) → it won't accept more; do not
  // try to "recover" a full car (this is the deploy-time car-at-80% case).
  const full = decideSession(
    after,
    input({ status: 'SuspendedEV', carCharging: false, carAtTarget: true, now: 100_000 }),
    cfg,
  )
  expect(full.action.kind).toBe('none')
  expect(full.next).toEqual(fresh)
})

test('escalates through the full session-open ladder, clamps at reset, then gives up at the cap', () => {
  const at = (state: SessionReconcilerState, now: number) =>
    decideSession(state, input({ status: 'SuspendedEV', carCharging: false, now }), cfg)
  // wake → resume → clear-profile → reset → reset(clamped) → reset(clamped), spaced past cooldown.
  const kinds: string[] = []
  let state: SessionReconcilerState = { ...fresh, stalledSinceMs: 0 }
  for (let i = 0; i < 6; i++) {
    const r = at(state, 100_000 + i * cfg.cooldownMs)
    kinds.push(r.action.kind)
    state = r.next
  }
  expect(kinds).toEqual(['wake-car', 'resume', 'clear-profile', 'reset', 'reset', 'reset'])
  expect(state.totalActions).toBe(6)
  // Cap reached → go quiet (health surfaces the fault; a new episode re-arms it).
  expect(at(state, 100_000 + 6 * cfg.cooldownMs).action.kind).toBe('none')
})

test('cooldown spaces actions — no second action within cooldownMs', () => {
  const r = decideSession(
    { ...fresh, stalledSinceMs: 0 },
    input({ status: 'Preparing', carCharging: undefined, now: 100_000 }),
    cfg,
  )
  expect(r.action.kind).toBe('remote-start')
  // 179s later (< 180s cooldown) → still cooling down.
  expect(
    decideSession(r.next, input({ status: 'Preparing', carCharging: undefined, now: 279_000 }), cfg)
      .action.kind,
  ).toBe('none')
})

test('Unavailable (often our own reset dropping the socket) preserves the episode — no reset loop', () => {
  // Mid-episode: we've already acted twice. A transient Unavailable must NOT reset the counters,
  // else a reset-induced disconnect would re-arm the ladder and spin forever.
  const mid: SessionReconcilerState = {
    stalledSinceMs: 0,
    lastActionMs: 100_000,
    phaseAttempts: 2,
    totalActions: 4,
    phase: 'session-open',
  }
  const r = decideSession(mid, input({ status: 'Unavailable', now: 200_000 }), cfg)
  expect(r.action.kind).toBe('none')
  expect(r.next).toBe(mid) // held verbatim — attempt cap survives the disconnect
})

test('Faulted → Hard reset', () => {
  const r = decideSession(
    { ...fresh, stalledSinceMs: 0 },
    input({ status: 'Faulted', now: 100_000 }),
    cfg,
  )
  expect(r.action.kind).toBe('reset')
  expect(r.next.phase).toBe('faulted')
})

test('Available but the car reports plugged → treated as present (a missed auto-start) → RemoteStart', () => {
  const r = decideSession(
    { ...fresh, stalledSinceMs: 0 },
    input({ status: 'Available', carPluggedIn: true, carCharging: undefined, now: 100_000 }),
    cfg,
  )
  expect(r.action.kind).toBe('remote-start')
})

test('feature-detection: skips levers the hardware cannot pull', () => {
  const after = { ...fresh, stalledSinceMs: 0 }
  // No vehicle actuation → the session-open ladder starts at resume (wake-car omitted).
  expect(
    decideSession(
      after,
      input({ status: 'SuspendedEV', carCharging: false, vehicleCanActuate: false, now: 100_000 }),
      cfg,
    ).action.kind,
  ).toBe('resume')
  // No RemoteStart but can reset → no-session falls straight to reset.
  expect(
    decideSession(
      after,
      input({
        status: 'Preparing',
        carCharging: undefined,
        chargerCanRemoteStart: false,
        now: 100_000,
      }),
      cfg,
    ).action.kind,
  ).toBe('reset')
  // No levers at all → nothing to do (but the episode is still tracked for when a lever appears).
  const none = decideSession(
    after,
    input({
      status: 'Preparing',
      carCharging: undefined,
      vehicleCanActuate: false,
      chargerCanRemoteStart: false,
      chargerCanClearProfile: false,
      chargerCanReset: false,
      now: 100_000,
    }),
    cfg,
  )
  expect(none.action.kind).toBe('none')
})
