import type { ModuleHealth } from '../sdk/types.js'

export interface HealthEntry {
  id: string
  health: ModuleHealth
  checkedAt: Date
}

export type HealthMap = Map<string, HealthEntry>

export const createHealthMap = (): HealthMap => new Map()

export const updateHealth = (map: HealthMap, id: string, health: ModuleHealth): void => {
  map.set(id, { id, health, checkedAt: new Date() })
}

/** Drop a module from the health map — used when a module is removed at runtime (reconcile),
 *  so it stops showing up in the health summary. */
export const removeHealth = (map: HealthMap, id: string): void => {
  map.delete(id)
}

export const getHealthSummary = (map: HealthMap): Record<string, ModuleHealth> => {
  const out: Record<string, ModuleHealth> = {}
  for (const [id, entry] of map) {
    out[id] = entry.health
  }
  return out
}
