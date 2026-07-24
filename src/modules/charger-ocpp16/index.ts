import { registerCharger } from '../../sdk/registry-api.js'
import type { Charger, ChargerStatus } from '../../sdk/charger.js'
import type { ModuleHealth } from '../../sdk/types.js'
import { OcppServer } from './server.js'
import { createDebouncedSetter } from './debounce.js'

// Singleton OCPP server shared across all ocpp16 charger instances.
// The server is created on first module load; subsequent charger factories
// attach to the same WS server.
let sharedServer: OcppServer | undefined

export function getOcppServer(): OcppServer | undefined {
  return sharedServer
}

registerCharger({
  type: 'ocpp16',

  create(cfg, ctx) {
    const config = cfg as {
      name?: string
      stationId: string
      maxA?: number
      autoStartTransaction?: boolean
      minWriteIntervalSec?: number
      phases?: number
    }

    const stationId = config.stationId
    const maxA = config.maxA ?? 16

    // Lazily create the shared server on first charger instantiation
    if (!sharedServer) {
      sharedServer = new OcppServer(ctx.db, ctx.log, 6)
    }

    sharedServer.registerStation(stationId, config.autoStartTransaction ?? true)
    sharedServer.setStationPhases(stationId, config.phases ?? 3)

    const debouncedSet = createDebouncedSetter({
      minIntervalMs: (config.minWriteIntervalSec ?? 10) * 1000,
      now: Date.now.bind(Date),
      schedule: (fn, delay) => setTimeout(fn, delay),
      write: (amps) => sharedServer!.setLimit(stationId, amps),
    })

    const charger: Charger = {
      get id() {
        return stationId
      },

      async start() {
        ctx.log.info({ stationId }, 'charger started')
      },

      async stop() {
        ctx.log.info({ stationId }, 'charger stopped')
      },

      async setCurrentLimit(amps: number) {
        const limit = Math.max(0, Math.min(amps, maxA))
        await debouncedSet(limit)
      },

      async remoteStart(idTag?: string) {
        await sharedServer!.remoteStart(stationId, idTag)
      },

      async remoteStop() {
        await sharedServer!.remoteStop(stationId)
      },

      async reset(type: 'Soft' | 'Hard' = 'Soft') {
        await sharedServer!.reset(stationId, type)
      },

      async clearChargingProfile() {
        return sharedServer!.clearChargingProfile(stationId)
      },

      async getCompositeSchedule(durationSec = 60) {
        return sharedServer!.getCompositeSchedule(stationId, durationSec)
      },

      async setOneShotProfile(amps: number) {
        const limit = Math.max(0, Math.min(amps, maxA))
        await sharedServer!.setLimit(stationId, limit)
      },

      health(): ModuleHealth {
        return sharedServer?.getHealth() ?? 'unavailable'
      },

      onStatus(cb: (status: ChargerStatus) => void) {
        return sharedServer!.onStatus(stationId, cb)
      },
    }

    return charger
  },
})
