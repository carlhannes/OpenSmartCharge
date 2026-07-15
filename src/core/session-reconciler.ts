import type { Logger } from 'pino'
import type { Charger, ChargerStatus } from '../sdk/charger.js'
import type { Vehicle } from '../sdk/vehicle.js'

// ── The charging-session reconciler ───────────────────────────────────────────────────────────
//
// A LEVEL-TRIGGERED controller for one loadpoint: every control tick it observes desired vs actual
// and, if they diverge past a grace window, takes ONE guarded corrective action — never more than
// one per cooldown, and only up to a bounded number of escalations per stall episode. It replaces
// the old transaction-gated resume-nudge, which could only RESUME an already-open transaction and
// so structurally could not recover a charger sitting `Available` or a car paused at the car side.
//
// Desired: "OSC wants this loadpoint charging now" — passed in as `wantsCharge` (the control loop's
// commanded amps > 0, which already folds in mode + price + budget). Actual: the OCPP connector
// status, the live draw, and (when a vehicle is attached) the car's own charging/plug telemetry.
//
// Stability-first: this NEVER runs faster than the ~30 s control lifecycle, and every action is
// gated by grace (absorb the normal ramp), cooldown (let an action take effect before the next),
// and a global per-episode cap (then it goes quiet and lets health surface the fault, rather than
// hammering a genuinely stuck car forever). An episode resets the moment the car draws again, the
// user stops wanting charge, or the connector goes genuinely idle.

/** Connector states that hold an OPEN transaction (a session exists, drawing or suspended). */
const SESSION_OPEN: ReadonlySet<ChargerStatus['status']> = new Set([
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
])

/** The corrective action to take this tick (one lever from the escalating ladder), or none. */
export type SessionAction =
  | { kind: 'none' }
  /** No open transaction but a car is present + we want charge → RemoteStart to open a session. */
  | { kind: 'remote-start' }
  /** Open transaction latched at ~0 A (VW-group SuspendedEV after a 0 A pause) → fresh transaction. */
  | { kind: 'resume' }
  /** Session open but the car reports charging OFF (chargeMode OFF / interrupted) → wake it car-side.
   *  The one lever no charger-side OCPP command can pull; only takes effect against an open session. */
  | { kind: 'wake-car' }
  /** Persistent 0 A despite an open session + a raised limit → a leftover high-stack 0 A profile may
   *  be suppressing us; clear all profiles then re-assert ours. */
  | { kind: 'clear-profile' }
  /** Last resort — cold control-pilot re-assertion (a software replug), from any state. */
  | { kind: 'reset' }

/** Which sub-state the escalation ladder is scoped to (the attempt counter resets when it flips). */
type SessionPhase = 'no-session' | 'session-open' | 'faulted'

export interface SessionReconcilerState {
  /** When the current "wants charge but not drawing" episode began (ms epoch), or undefined. */
  stalledSinceMs?: number
  /** When we last took a corrective action (ms epoch), or undefined. */
  lastActionMs?: number
  /** Corrective actions taken in the CURRENT phase — drives the ladder rung; resets on phase flip. */
  phaseAttempts: number
  /** Corrective actions taken this whole episode — the global give-up cap; survives phase flips so a
   *  reset-induced disconnect can't reset it into a loop. */
  totalActions: number
  /** The phase `phaseAttempts` is counted within (to detect a flip). */
  phase?: SessionPhase
}

export interface SessionReconcilerCfg {
  /** At or above this many amps the car counts as "drawing" (episode is healthy). */
  minDrawA: number
  /** Absorb the normal ramp (OCPP auto-start + SuspendedEVSE→Charging) before acting. */
  graceMs: number
  /** Wait this long after an action before the next (each lever needs time to take + ramp). */
  cooldownMs: number
  /** Give up after this many actions in one episode (then quiet — health surfaces the fault). */
  maxActions: number
}

/** Guards generalized from the old RESUME_NUDGE. Grace/cooldown mirror it; maxActions is raised
 *  from 3 to cover the richer ladder (a full recovery can be RemoteStart → wake → resume → …). */
export const SESSION_RECONCILE: SessionReconcilerCfg = {
  minDrawA: 1,
  graceMs: 90_000,
  cooldownMs: 180_000,
  maxActions: 6,
}

export interface SessionInput {
  /** OSC wants charge now (commanded amps > 0). */
  wantsCharge: boolean
  /** OCPP connector status; undefined before the first status frame (treated as not-present). */
  status?: ChargerStatus['status']
  /** Live draw (A). */
  drawingA: number
  /** The car's own plug view (cross-check independent of OCPP), if a vehicle is attached. */
  carPluggedIn?: boolean
  /** The car's own charging view — false means the car is NOT charging (e.g. chargeMode OFF).
   *  When TRUE we trust it and do NOT recover: the car may be tapering below minDrawA near full,
   *  or its telemetry may briefly lag — either way it is making progress, so leave it alone. */
  carCharging?: boolean
  /** The car has reached its OWN charge ceiling (SoC ≥ the car's care limit) — it will not accept
   *  more current no matter what OSC commands, so a 0 A draw here is expected, not a stall. In
   *  smart mode `wantsCharge` already goes false at target; this covers FAST mode, which commands
   *  current unconditionally. Prevents fighting (or resetting) a car that is simply full. */
  carAtTarget?: boolean
  /** The plug-in session has completed — a real SoC target was met, or the car itself stopped taking
   *  charge after delivering energy. The GUEST-CAPABLE generalization of `carAtTarget` (needs no car
   *  telemetry): the lifecycle derives it from OCPP draw + the resolved target. When true there is
   *  nothing to recover — do not resume/restart. See smart-charging/session-complete.ts. */
  sessionComplete?: boolean
  /** Feature-detect: the vehicle exposes a car-side start (Vehicle.startCharging). */
  vehicleCanActuate: boolean
  /** Feature-detect: the charger exposes RemoteStart/Stop. */
  chargerCanRemoteStart: boolean
  /** Feature-detect: the charger exposes ClearChargingProfile. */
  chargerCanClearProfile: boolean
  /** Feature-detect: the charger exposes Reset. */
  chargerCanReset: boolean
  /** ms epoch. */
  now: number
}

export interface SessionDecision {
  action: SessionAction
  next: SessionReconcilerState
  /** Human-readable why, for the log line on an action (undefined when action is none). */
  reason?: string
}

const idleState: SessionReconcilerState = { phaseAttempts: 0, totalActions: 0 }

function phaseOf(status: ChargerStatus['status'] | undefined): SessionPhase {
  if (status && SESSION_OPEN.has(status)) return 'session-open'
  if (status === 'Faulted') return 'faulted'
  return 'no-session' // Available(+plugged) / Preparing / Finishing / Reserved / unknown
}

/**
 * Build the escalating ladder for a phase, skipping levers the hardware can't pull, and pick the
 * rung for this attempt (clamped to the last rung). The ladder ORDER encodes the recovery strategy:
 *  - no-session: get a transaction open (RemoteStart), else cold-reset the charger.
 *  - session-open (held but ~0 A): ordered by the car's OWN signal — if the car reports it is NOT
 *    charging (chargeMode OFF / interrupted), a car-side wake is the exact fix, so try it first;
 *    otherwise (the car's charging signal is UNKNOWN — no/failed telemetry; a car reporting it IS
 *    charging never reaches here, it resets the episode) a SuspendedEV latch is the likelier cause,
 *    so open a fresh transaction first and keep the car-side wake as a fallback rung. Then clear a
 *    suppressing profile, then reset. This generalizes the proven manual recovery (open session →
 *    car-side start).
 *  - faulted: reset.
 */
function chooseAction(input: SessionInput, phase: SessionPhase, attempt: number): SessionAction {
  const ladder: SessionAction[] = []
  if (phase === 'faulted') {
    if (input.chargerCanReset) ladder.push({ kind: 'reset' })
  } else if (phase === 'no-session') {
    if (input.chargerCanRemoteStart) ladder.push({ kind: 'remote-start' })
    if (input.chargerCanReset) ladder.push({ kind: 'reset' })
  } else {
    // session-open
    const wake: SessionAction | null = input.vehicleCanActuate ? { kind: 'wake-car' } : null
    const resume: SessionAction | null = input.chargerCanRemoteStart ? { kind: 'resume' } : null
    if (input.carCharging === false) {
      if (wake) ladder.push(wake)
      if (resume) ladder.push(resume)
    } else {
      if (resume) ladder.push(resume)
      if (wake) ladder.push(wake)
    }
    if (input.chargerCanClearProfile) ladder.push({ kind: 'clear-profile' })
    if (input.chargerCanReset) ladder.push({ kind: 'reset' })
  }
  if (ladder.length === 0) return { kind: 'none' }
  return ladder[Math.min(attempt, ladder.length - 1)]
}

/**
 * Pure decision core: given the stored guard-state, the observed input, and the config, return the
 * corrective action (at most one) and the next guard-state. No side effects, no clocks — `now` is
 * passed in — so it's exhaustively unit-testable.
 */
export function decideSession(
  state: SessionReconcilerState,
  input: SessionInput,
  cfg: SessionReconcilerCfg,
): SessionDecision {
  const drawing = input.drawingA >= cfg.minDrawA
  // Genuinely idle = connector Available AND the car isn't plugged (or we can't tell). This is the
  // "nothing to charge" state — distinct from Available-but-car-says-plugged, which we DO act on.
  const genuinelyIdle = input.status === 'Available' && input.carPluggedIn !== true

  // Episode-reset states: we're fine or there's genuinely nothing to recover → clear the episode so
  // the next real stall starts fresh with full grace + a fresh ladder. We recover ONLY when the car
  // is not making progress AND could accept charge; we defer to the car's own signals:
  //  - not wanting charge (paused at target in smart mode, or disabled),
  //  - actually drawing,
  //  - the car reports it IS charging (trust it — a near-full taper can sit below minDrawA),
  //  - the car has hit its own care ceiling (won't take more — the FAST-mode full-car case),
  //  - the session is complete (target met, or the car stopped itself — the guest-capable case),
  //  - the connector is genuinely idle (Available + not plugged).
  if (
    !input.wantsCharge ||
    drawing ||
    input.carCharging === true ||
    input.carAtTarget === true ||
    input.sessionComplete === true ||
    genuinelyIdle
  ) {
    return { action: { kind: 'none' }, next: { ...idleState } }
  }

  // Charger transiently gone (Unavailable — commonly our OWN reset dropping the socket, or a flaky
  // link): we can't act, but we PRESERVE the episode so a reset-induced disconnect can't reset the
  // global cap and spin a reset loop. Grace/cooldown/cap resume once it reconnects.
  if (input.status === 'Unavailable' || input.status === undefined) {
    return { action: { kind: 'none' }, next: state }
  }

  // Stalled: wants charge, a car is present, but not drawing.
  const stalledSinceMs = state.stalledSinceMs ?? input.now
  const phase = phaseOf(input.status)
  // Reset the ladder rung when the sub-state flips (e.g. RemoteStart just opened a session:
  // no-session → session-open, so the next lever is wake-car, not wherever no-session left off).
  const phaseAttempts = state.phase === phase ? state.phaseAttempts : 0
  const base: SessionReconcilerState = { ...state, stalledSinceMs, phase, phaseAttempts }

  if (input.now - stalledSinceMs < cfg.graceMs) return { action: { kind: 'none' }, next: base }
  if (state.totalActions >= cfg.maxActions) return { action: { kind: 'none' }, next: base } // gave up
  if (state.lastActionMs !== undefined && input.now - state.lastActionMs < cfg.cooldownMs)
    return { action: { kind: 'none' }, next: base } // cooling down

  const action = chooseAction(input, phase, phaseAttempts)
  if (action.kind === 'none') return { action, next: base } // nothing applicable this phase

  return {
    action,
    reason: reasonFor(action, phase, input),
    next: {
      stalledSinceMs,
      lastActionMs: input.now,
      phase,
      phaseAttempts: phaseAttempts + 1,
      totalActions: state.totalActions + 1,
    },
  }
}

function reasonFor(action: SessionAction, phase: SessionPhase, input: SessionInput): string {
  switch (action.kind) {
    case 'remote-start':
      return `wants charge, ${phase} (status ${input.status}) — RemoteStart to open a session`
    case 'resume':
      return `open session drawing ~0 A (status ${input.status}) — RemoteStop+RemoteStart to un-latch`
    case 'wake-car':
      return `session open but car reports not charging — car-side start-charge`
    case 'clear-profile':
      return `persistent 0 A with an open session — clearing charging profiles then re-asserting`
    case 'reset':
      return `recovery ladder exhausted for ${phase} — Hard reset (cold control-pilot re-assert)`
    default:
      return ''
  }
}

export interface SessionActuators {
  charger: Charger
  vehicle?: Vehicle
  /** The amps to re-assert after a profile clear (this tick's commanded limit for the loadpoint). */
  reassertLimitA: number
}

/**
 * Execute one corrective action. Thin, best-effort effects: each lever is wrapped so a failing
 * command surfaces in the log but never throws into the control loop (the reconciler will simply
 * escalate on the next attempt). Separated from the pure decision so the ladder logic stays testable.
 */
export async function executeSessionAction(
  action: SessionAction,
  act: SessionActuators,
  log: Logger,
): Promise<void> {
  const { charger, vehicle } = act
  switch (action.kind) {
    case 'remote-start':
      await charger.remoteStart?.().catch((err) => log.warn({ err }, 'session: RemoteStart failed'))
      return
    case 'resume':
      // No-op if there is no active transaction; then a fresh RemoteStart opens one.
      await charger.remoteStop?.().catch(() => {})
      await charger
        .remoteStart?.()
        .catch((err) => log.warn({ err }, 'session: resume RemoteStart failed'))
      return
    case 'wake-car':
      await vehicle
        ?.startCharging?.()
        .catch((err) => log.warn({ err }, 'session: car start-charge failed'))
      return
    case 'clear-profile':
      await charger
        .clearChargingProfile?.()
        .catch((err) => log.warn({ err }, 'session: ClearChargingProfile failed'))
      // Re-assert our limit immediately so clearing doesn't leave the charger unprofiled.
      await charger
        .setCurrentLimit(act.reassertLimitA)
        .catch((err) => log.warn({ err }, 'session: re-assert limit after clear failed'))
      return
    case 'reset':
      await charger.reset?.('Hard').catch((err) => log.warn({ err }, 'session: Hard reset failed'))
      return
    case 'none':
      return
  }
}
