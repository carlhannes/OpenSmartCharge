import { registerCharger } from '../../sdk/registry-api.js'
import type { Charger, ChargerStatus } from '../../sdk/charger.js'
import type { ModuleHealth } from '../../sdk/types.js'
import { OcppServer } from './server.js'
import { createDebouncedSetter } from './debounce.js'
import { DEFAULT_PHASES } from '../../sdk/electrical.js'

// Singleton OCPP server shared across all ocpp16 charger instances. The lifecycle starts it at boot
// (ensureOcppServer) so a fresh install already listens; each charger factory attaches to it.
let sharedServer: OcppServer | undefined

export function getOcppServer(): OcppServer | undefined {
  return sharedServer
}

// Create the shared OCPP WS server if it isn't up yet, and return it. The lifecycle calls this at boot
// so OSC ALWAYS listens for OCPP — a charger that connects to a fresh, not-yet-configured install then
// shows up as an unclaimed "pending" station the onboarding flow can claim. Without this the server
// only started once a charger was already configured, which is a chicken-and-egg on first run
// ("waiting for a charger to connect…" would hang forever).
export function ensureOcppServer(
  db: ConstructorParameters<typeof OcppServer>[0],
  log: ConstructorParameters<typeof OcppServer>[1],
): OcppServer {
  if (!sharedServer) sharedServer = new OcppServer(db, log, 6)
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

    // Attach to the shared OCPP server (started at boot by the lifecycle so a fresh install already
    // listens for unclaimed chargers; created here too if for some reason it isn't up yet).
    ensureOcppServer(ctx.db, ctx.log)

    sharedServer!.registerStation(stationId, config.autoStartTransaction ?? true)
    sharedServer!.setStationPhases(stationId, config.phases ?? DEFAULT_PHASES)

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
