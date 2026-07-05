import type { DatabaseSync } from 'node:sqlite'
import type { Config, LoadpointConfig } from './config.js'
import type { EventBus } from './events.js'
import { updateHealth, type HealthMap } from './health.js'
import type { ModuleCtx } from '../sdk/types.js'
import type { Charger } from '../sdk/charger.js'
import type { Tariff } from '../sdk/tariff.js'
import type { Balancer } from '../sdk/balancer.js'
import type { Vehicle } from '../sdk/vehicle.js'
import type { MeterReader } from '../sdk/meter-reader.js'
import type { LoadpointState } from './loadpoint.js'
import { createTariff, createBalancer } from './registry.js'
import { getEffectiveConfig } from './config-overrides.js'

// The reconcile seam: after an API write persists a config override, the lifecycle rebuilds the
// affected module from the new EFFECTIVE config and mutates the shared `config` object IN PLACE
// (so every by-reference reader — the control loop, GET /api/site — sees the change). This is what
// makes OSC declarative: a module is a mapper of its config, so changing config = soft-reload the
// module. Safe because durable state is in SQLite, desired state is re-derived each tick, and
// observed state is re-reported by hardware on reconnect (see AGENTS.md → declarative modules).

export interface ReconcileDeps {
  /** Parsed osc.yaml (the seed), for recomputing the effective config on each change. */
  base: Config
  /** The live effective config — mutated IN PLACE so all by-reference holders see changes. */
  config: Config
  db: DatabaseSync
  ctx: ModuleCtx
  events: EventBus
  health: HealthMap
  chargers: Map<string, Charger>
  tariffs: Map<string, Tariff>
  meterReaders: Map<string, MeterReader>
  vehicles: Map<string, Vehicle>
  balancers: Map<string, Balancer>
  loadpointStates: Map<string, LoadpointState>
  chargerLimitMap: Map<string, Charger>
  chargerUnsubs: Map<string, () => void>
  wireChargerStatus: (lpCfg: LoadpointConfig, charger: Charger, state: LoadpointState) => void
  rebuildCircuits: () => void
}

export interface Reconciler {
  reloadTariff(name: string): Promise<void>
  reloadBalancer(name: string): Promise<void>
  reloadSite(): void
}

export function createReconciler(d: ReconcileDeps): Reconciler {
  // The desired entity for `name`: recompute the effective config (osc.yaml + DB overrides) and
  // pull it out of the given array. Returns undefined if the entity no longer exists.
  const desired = <T extends { name: string }>(key: keyof Config, name: string): T | undefined =>
    (getEffectiveConfig(d.base, d.db)[key] as unknown as T[]).find((e) => e.name === name)

  // Replace (or append) the named entity in the live config array, keeping the array reference so
  // the control loop's closure and every other holder see the update.
  const syncEntity = (key: keyof Config, cfg: { name: string }): void => {
    const arr = d.config[key] as unknown as { name: string }[]
    const i = arr.findIndex((e) => e.name === cfg.name)
    if (i >= 0) arr[i] = cfg
    else arr.push(cfg)
  }

  return {
    async reloadTariff(name) {
      const cfg = desired<{ name: string; type: string }>('tariffs', name)
      if (!cfg) return
      syncEntity('tariffs', cfg)
      // Create + start the new module BEFORE stopping the old, so an in-flight tick (which reads
      // tariffs.get() at its top) never sees a stopped module.
      const old = d.tariffs.get(name)
      const t = createTariff(cfg.type, cfg, d.ctx)
      await t.start()
      d.tariffs.set(name, t)
      updateHealth(d.health, name, t.health())
      if (old) await old.stop()
      d.events.emit('config.changed', { kind: 'tariff', name })
    },

    async reloadBalancer(name) {
      const cfg = desired<{ name: string; type: string }>('balancers', name)
      if (!cfg) return
      syncEntity('balancers', cfg)
      const old = d.balancers.get(name)
      const b = createBalancer(cfg.type, cfg, d.ctx)
      await b.start()
      d.balancers.set(name, b)
      updateHealth(d.health, name, b.health())
      if (old) await old.stop() // stop() unwires its meter listener + ends its MQTT client
      d.events.emit('config.changed', { kind: 'balancer', name })
    },

    // No module owns site.* — the control loop reads config.site.mainBreakerA live each tick — so a
    // config mutation is all that's needed.
    reloadSite() {
      Object.assign(d.config.site, getEffectiveConfig(d.base, d.db).site)
      d.events.emit('config.changed', { kind: 'site', name: 'site' })
    },
  }
}
