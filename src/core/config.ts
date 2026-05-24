import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { z } from 'zod'

const chargeModeSchema = z.enum(['disabled', 'smart', 'fast'])

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
})

const configSchema = z.object({
  site: siteConfigSchema.default({}),
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

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, 'utf8')
  const parsed = parse(raw)
  return configSchema.parse(parsed)
}
