import { registerCharger } from '../../sdk/registry-api.js'
import type { Charger, ChargerStatus } from '../../sdk/charger.js'
import type { ModuleHealth } from '../../sdk/types.js'
import { OcppServer } from './server.js'

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
      autoStart?: boolean
    }

    const stationId = config.stationId
    const maxA = config.maxA ?? 16

    // Lazily create the shared server on first charger instantiation
    if (!sharedServer) {
      sharedServer = new OcppServer(ctx.db, ctx.log, 6)
    }

    sharedServer.registerStation(stationId, config.autoStart ?? true)

    const charger: Charger = {
      get id() { return stationId },

      async start() {
        ctx.log.info({ stationId }, 'charger started')
      },

      async stop() {
        ctx.log.info({ stationId }, 'charger stopped')
      },

      async setCurrentLimit(amps: number) {
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
