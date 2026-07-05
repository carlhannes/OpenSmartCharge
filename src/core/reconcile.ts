import type { DatabaseSync } from 'node:sqlite'
import type { Config, LoadpointConfig } from './config.js'
import type { EventBus } from './events.js'
import { updateHealth, removeHealth, type HealthMap } from './health.js'
import type { ModuleCtx } from '../sdk/types.js'
import type { Charger } from '../sdk/charger.js'
import type { Tariff } from '../sdk/tariff.js'
import type { Balancer } from '../sdk/balancer.js'
import type { Vehicle } from '../sdk/vehicle.js'
import type { MeterReader } from '../sdk/meter-reader.js'
import { loadLoadpointStates, configToLoadpointInits, type LoadpointState } from './loadpoint.js'
import { createTariff, createBalancer, createCharger } from './registry.js'
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
  addCharger(name: string): Promise<void>
  reloadCharger(name: string): Promise<void>
  removeCharger(name: string): Promise<void>
  addLoadpoint(name: string): void
  removeLoadpoint(name: string): void
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
      // Build + start the new module FIRST; only on success mutate config + swap the Map, so a
      // failed build leaves config and the running module untouched. Then stop the old — an
      // in-flight tick reads tariffs.get() at its top, so it finishes on the old instance.
      const old = d.tariffs.get(name)
      const t = createTariff(cfg.type, cfg, d.ctx)
      await t.start()
      syncEntity('tariffs', cfg)
      d.tariffs.set(name, t)
      updateHealth(d.health, name, t.health())
      if (old) await old.stop()
      d.events.emit('config.changed', { kind: 'tariff', name })
    },

    async reloadBalancer(name) {
      const cfg = desired<{ name: string; type: string }>('balancers', name)
      if (!cfg) return
      const old = d.balancers.get(name)
      const b = createBalancer(cfg.type, cfg, d.ctx)
      await b.start()
      syncEntity('balancers', cfg)
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

    // Instantiate a newly-claimed charger. createCharger runs the module's create(), which registers
    // the OCPP station + phases on the shared server (claiming an already-connected socket). Pair
    // with addLoadpoint — a charger with no loadpoint does nothing.
    async addCharger(name) {
      const cfg = desired<{ name: string; type: string }>('chargers', name)
      if (!cfg) return
      const c = createCharger(cfg.type, cfg, d.ctx)
      await c.start()
      syncEntity('chargers', cfg)
      d.chargers.set(name, c)
      updateHealth(d.health, name, c.health())
      d.events.emit('config.changed', { kind: 'charger', name })
    },

    async reloadCharger(name) {
      const cfg = desired<{ name: string; type: string; maxA?: number }>('chargers', name)
      if (!cfg) return
      const old = d.chargers.get(name)
      const c = createCharger(cfg.type, cfg, d.ctx) // new handle over the same shared WS server
      await c.start()
      syncEntity('chargers', cfg)
      d.chargers.set(name, c)
      updateHealth(d.health, name, c.health())
      // Re-point every loadpoint on this charger: rewire onStatus to the new handle, refresh the
      // limit map, and re-capture maxA (it lives on both the handle and LoadpointState).
      for (const lp of d.config.loadpoints.filter((l) => l.charger === name)) {
        d.chargerLimitMap.set(lp.name, c)
        const st = d.loadpointStates.get(lp.name)
        if (st) {
          if (typeof cfg.maxA === 'number') st.maxCurrentA = cfg.maxA
          d.wireChargerStatus(lp, c, st)
        }
      }
      if (old) await old.stop()
      d.events.emit('config.changed', { kind: 'charger', name })
    },

    async removeCharger(name) {
      const old = d.chargers.get(name)
      d.chargers.delete(name)
      removeHealth(d.health, name)
      const i = d.config.chargers.findIndex((c) => c.name === name)
      if (i >= 0) d.config.chargers.splice(i, 1)
      if (old) await old.stop()
      d.events.emit('config.changed', { kind: 'charger', name })
    },

    addLoadpoint(name) {
      const cfg = desired<LoadpointConfig>('loadpoints', name)
      if (!cfg) return
      syncEntity('loadpoints', cfg)
      // Seed + adopt the loadpoint's runtime state (INSERT OR IGNORE; existing rows untouched).
      const seeded = loadLoadpointStates(d.db, configToLoadpointInits(d.config)).get(name)
      if (seeded) d.loadpointStates.set(name, seeded)
      const charger = d.chargers.get(cfg.charger)
      const st = d.loadpointStates.get(name)
      if (charger && st) {
        d.chargerLimitMap.set(name, charger)
        d.wireChargerStatus(cfg, charger, st)
      }
      d.rebuildCircuits()
      d.events.emit('config.changed', { kind: 'loadpoint', name })
    },

    removeLoadpoint(name) {
      const i = d.config.loadpoints.findIndex((l) => l.name === name)
      if (i < 0) return
      d.config.loadpoints.splice(i, 1)
      d.chargerUnsubs.get(name)?.()
      d.chargerUnsubs.delete(name)
      d.chargerLimitMap.delete(name)
      d.loadpointStates.delete(name)
      d.rebuildCircuits()
      d.events.emit('config.changed', { kind: 'loadpoint', name })
    },
  }
}
