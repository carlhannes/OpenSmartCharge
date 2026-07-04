import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { z } from 'zod'
import { isValidTimeZone } from '../sdk/local-time.js'

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
    // Look-back window for the historical price-average and worst-case-load rungs.
    historicalDays: z.number().int().min(1).max(30).default(3),
    // Vehicle telemetry is polled ONLY on charger-connect and during active charging, at most
    // this often (default 30 min ≈ the price cadence). Never polled while idle — polling MySkoda
    // too often can wake/drain the car and risk an account lockout.
    vehiclePollIntervalSec: z.number().min(300).max(3600).default(1800),
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
    meterTopicPrefix: z.string().default('house'),
    meterReader: z.string().optional(),
    safeStaticCurrentA: z.number().default(10),
    meterStaleAfterSec: z.number().default(60),
    intervalSec: z.number().default(15),
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
  /** Auto-start a transaction when a vehicle connects (default: true) */
  autoStart: z.boolean().default(true),
})

const mqttConfigSchema = z.object({
  host: z.string().default('localhost'),
  port: z.number().default(1883),
  user: z.string().optional(),
  password: z.string().optional(),
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

const configSchema = z.object({
  site: siteConfigSchema.default({}),
  smartCharging: smartChargingConfigSchema,
  mqtt: mqttConfigSchema.optional(),
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
  return configSchema.parse(parsed)
}
