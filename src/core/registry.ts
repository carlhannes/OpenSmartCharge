import {
  getChargerModule,
  getTariffModule,
  getBalancerModule,
  getVehicleModule,
  getMeterReaderModule,
} from '../sdk/registry-api.js'
import type { ModuleCtx } from '../sdk/types.js'
import type { Charger } from '../sdk/charger.js'
import type { Tariff } from '../sdk/tariff.js'
import type { Balancer } from '../sdk/balancer.js'
import type { Vehicle } from '../sdk/vehicle.js'
import type { MeterReader } from '../sdk/meter-reader.js'

export function createCharger(type: string, cfg: unknown, ctx: ModuleCtx): Charger {
  const mod = getChargerModule(type)
  if (!mod) throw new Error(`Unknown charger type: "${type}". Is the module registered?`)
  return mod.create(cfg, ctx)
}

export function createTariff(type: string, cfg: unknown, ctx: ModuleCtx): Tariff {
  const mod = getTariffModule(type)
  if (!mod) throw new Error(`Unknown tariff type: "${type}". Is the module registered?`)
  return mod.create(cfg, ctx)
}

export function createBalancer(type: string, cfg: unknown, ctx: ModuleCtx): Balancer {
  const mod = getBalancerModule(type)
  if (!mod) throw new Error(`Unknown balancer type: "${type}". Is the module registered?`)
  return mod.create(cfg, ctx)
}

export function createVehicle(type: string, cfg: unknown, ctx: ModuleCtx): Vehicle {
  const mod = getVehicleModule(type)
  if (!mod) throw new Error(`Unknown vehicle type: "${type}". Is the module registered?`)
  return mod.create(cfg, ctx)
}

export function createMeterReader(type: string, cfg: unknown, ctx: ModuleCtx): MeterReader {
  const mod = getMeterReaderModule(type)
  if (!mod) throw new Error(`Unknown meter reader type: "${type}". Is the module registered?`)
  return mod.create(cfg, ctx)
}
