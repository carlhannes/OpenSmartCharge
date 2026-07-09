import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { z } from 'zod'
import { isValidTimeZone } from '../sdk/local-time.js'
import { brokerSchema } from '../sdk/broker.js'

const chargeModeSchema = z.enum(['disabled', 'smart', 'fast'])

// Smart-charging control-loop cadence + graceful-degradation fallback tuning. Every field
// has a default, so the whole section is optional.
const smartChargingConfigSchema = z
  .object({
    // Control tick interval. Kept slow (default 30 s) because a charger/car takes 15–30 s to
    // act on a new limit; ticking faster just makes the offered current oscillate.
    controlIntervalSec: z.number().min(5).max(60).default(30),
    // Only re-command the charger when the target moves at least this many amps (anti-chatter).
    deadbandA: z.number().min(0).default(1),
    // Assumed-cheap night window in local Stockholm hours [startHour, endHour), wrapping
    // midnight. Used by the price fallback (night priced cheaper) and the static current
    // fallback (night gets the generous budget).
    nightWindow: z
      .object({
        startHour: z.number().int().min(0).max(23).default(23),
        endHour: z.number().int().min(0).max(23).default(5),
      })
      .default({}),
    // Static current fallback when there is no balancer and no load history:
    // night = mainBreakerA − nightMarginA, day = mainBreakerA × daytimeFraction.
    nightMarginA: z.number().min(0).default(3),
    daytimeFraction: z.number().min(0).max(1).default(0.5),
    // Steady-state safety headroom below the main fuse for the load-aware current rungs: the
    // charger targets (mainBreakerA − reserveA), so a household load-step has this much room before
    // the fuse and steady state never sits at zero margin. Kept modest — the control loop corrects a
    // brief overshoot on the next tick, so this shrinks overshoot MAGNITUDE without steering faster.
    // Set 0 to ride the fuse exactly. This is NOT the retired 6 A cap — it's a small margin, not a
    // hard limit; fast-mode still uses the full fuse minus this reserve.
    reserveA: z.number().min(0).default(1),
    // Look-back window for the historical price-average and worst-case-load rungs.
    historicalDays: z.number().int().min(1).max(30).default(3),
    // Vehicle telemetry poll cadence while actively drawing current (re-anchors the SoC estimate
    // against delivered energy) AND while connected-but-idle at night. Default 15 min. Polling too
    // often risks waking/draining a parked car + a provider lockout; the module backs off on 429.
    vehiclePollIntervalSec: z.number().min(300).max(3600).default(900),
    // Idle-poll cadence — car plugged in but NOT drawing (paused/idle). This faster interval applies
    // ONLY during the day window below; outside it OSC falls back to vehiclePollIntervalSec, so an
    // overnight-plugged car isn't polled aggressively. Catches remote climate/preconditioning + plug
    // changes the SoC estimate can't reveal. Each poll hits the vehicle API — raise if rate-limited.
    vehicleIdlePollIntervalSec: z.number().min(60).max(1800).default(600),
    // Local-hour window [start, end) during which the faster idle poll applies (else the slow rate).
    vehicleIdlePollDayWindow: z
      .object({
        startHour: z.number().int().min(0).max(23).default(6),
        endHour: z.number().int().min(0).max(23).default(22),
      })
      .default({}),
    // AC charging efficiency (energy into battery ÷ energy from grid) — tunes the between-poll
    // SoC estimate that carries a real reading forward by delivered kWh.
    chargingEfficiency: z.number().min(0.5).max(1).default(0.92),
  })
  .default({})

// .catchall allows type-specific fields (zone, stationId, credentials, etc.)
// to pass through to module factories as `cfg: unknown`
const namedModuleSchema = z.object({ name: z.string(), type: z.string() }).catchall(z.unknown())

const balancerConfigSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    mainBreakerA: z.number(),
    phases: z.number().int().min(1).max(3).default(3),
    // Live meter for the circuit: point at a meterReaders[] entry (the meter SSoT). `meterTopicPrefix`
    // is legacy (raw i1_a/i2_a/i3_a topics) — use a `meter-mqtt-phase` reader instead (docs/config.md).
    meterTopicPrefix: z.string().optional(),
    meterReader: z.string().optional(),
    // Per-circuit static-tod fallback margins, used when the meter is stale/absent (night =
    // mainBreakerA − nightMarginA, day = mainBreakerA × daytimeFraction). Unset → fall back to the
    // global smartCharging.* values. These replace the deprecated flat safeStaticCurrentA.
    nightMarginA: z.number().min(0).optional(),
    daytimeFraction: z.number().min(0).max(1).optional(),
    // Per-circuit steady-state safety headroom below this circuit's fuse (see smartCharging.reserveA).
    // Unset → fall back to the global smartCharging.reserveA.
    reserveA: z.number().min(0).optional(),
    // Deprecated + unused (the balancer is now a pure splitter; the meter + its staleness live on a
    // MeterReader). Optional/no-default so a boot WARN fires only when a user actually set one.
    safeStaticCurrentA: z.number().optional(),
    meterStaleAfterSec: z.number().optional(),
    intervalSec: z.number().optional(),
  })
  .catchall(z.unknown())

const loadpointConfigSchema = z.object({
  name: z.string(),
  charger: z.string(),
  vehicle: z.string().optional(),
  tariff: z.string().optional(),
  balancer: z.string().optional(),
  defaultMode: chargeModeSchema.default('smart'),
  targetSoc: z.number().min(0).max(100).optional(),
  targetTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'targetTime must be HH:MM')
    .optional(),
  // Fixed energy-to-add target (kWh) — the energy fallback when there's no vehicle SoC
  // (guest car / no app). Session-relative: charge until this session has delivered it.
  targetKWh: z.number().min(1).max(100).optional(),
  // Minimum SoC (%) safety floor. In smart mode, if the car's SoC drops below this, OSC
  // force-charges immediately (bypassing the price wait). See docs/config.md.
  minSoc: z.number().min(0).max(100).optional(),
})

// OSC's OUTBOUND MQTT bridge: publishes OSC's own state, accepts commands, and (optionally) emits Home
// Assistant discovery — a DISTINCT concern from meterReaders[] (which LISTEN on their own brokers). It
// carries its own `broker`, so reading a meter and OSC publishing are fully independent: omit
// `mqttBridge` and OSC publishes nothing to any broker.
const mqttBridgeSchema = z.object({
  broker: brokerSchema,
  topicPrefix: z.string().default('osc'),
  homeAssistantDiscovery: z.boolean().default(true),
})

const siteConfigSchema = z.object({
  name: z.string().default('OpenSmartCharge'),
  port: z.number().default(8080),
  // Main-fuse amps per phase, used as the circuit ceiling for loadpoints that have NO
  // balancer (the static/historical current fallback sizes against this). A balancer,
  // when configured, carries its own mainBreakerA per circuit.
  mainBreakerA: z.number().positive().optional(),
  // Site (user) timezone for all wall-clock planning — night window, plan ready-by, targets.
  // Seeds the settings table; the UI setup flow auto-detects + overrides it at runtime. (Tariff
  // providers use their own market timezone, not this.)
  timezone: z
    .string()
    .refine(isValidTimeZone, { message: 'site.timezone must be a valid IANA timezone' })
    .default('Europe/Stockholm'),
})

export const configSchema = z.object({
  site: siteConfigSchema.default({}),
  smartCharging: smartChargingConfigSchema,
  mqttBridge: mqttBridgeSchema.optional(),
  tariffs: z.array(namedModuleSchema).default([]),
  balancers: z.array(balancerConfigSchema).default([]),
  vehicles: z.array(namedModuleSchema).default([]),
  chargers: z.array(namedModuleSchema).default([]),
  meterReaders: z.array(namedModuleSchema).default([]),
  loadpoints: z.array(loadpointConfigSchema).default([]),
})

export type Config = z.infer<typeof configSchema>
export type LoadpointConfig = z.infer<typeof loadpointConfigSchema>
export type ChargeMode = z.infer<typeof chargeModeSchema>
export type SmartChargingConfig = z.infer<typeof smartChargingConfigSchema>

// Runtime paths (env-overridable). Single-sourced here so the server (lifecycle.ts) and the
// config-apply CLI resolve the same osc.yaml + data dir.
export const CONFIG_PATH = process.env.OSC_CONFIG ?? './osc.yaml'
export const DATA_DIR = process.env.OSC_DATA_DIR ?? './data'

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, 'utf8')
  const parsed = parse(raw)
  if (parsed && typeof parsed === 'object' && 'mqtt' in parsed) {
    // Migration aid: the old combined `mqtt:` block is gone. Inbound (a meter listening) now lives on
    // meterReaders[].broker; outbound (OSC publishing / Home Assistant) lives on `mqttBridge:`.
    console.warn(
      '[config] top-level `mqtt:` is no longer used and is ignored — split it into meterReaders[].broker (inbound, listen-only) and `mqttBridge:` (outbound publish/HA). See docs/config.md.',
    )
  }
  return configSchema.parse(parsed)
}
