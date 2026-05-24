import { registerVehicle } from '../../sdk/registry-api.js'
import type { VehicleData } from '../../sdk/vehicle.js'
import { parseConfig } from './types.js'
import { upsertVehicleCache, loadVehicleCache } from './persistence.js'
import { getVehicleDetails, getChargingStatus } from './api.js'
import { createAuthClient } from './auth.js'

registerVehicle({
  type: 'skoda',

  create(rawCfg, ctx) {
    const cfg = parseConfig(rawCfg)

    let last: VehicleData | null = loadVehicleCache(ctx.db, cfg.name)
    let lastOkAt = last ? last.fetchedAt.getTime() : 0
    let capacityKWh: number | undefined = last?.batteryCapacity
    let timer: ReturnType<typeof setInterval> | null = null

    const auth = createAuthClient(cfg, ctx)

    // Uses fetchFn so callers can pass jitterFetch for scheduled polls
    async function pollOnce(fetchFn: typeof globalThis.fetch): Promise<void> {
      try {
        const accessToken = await auth.token()

        const charging = await getChargingStatus(cfg.vin, accessToken, fetchFn)
        const soc = charging.status?.battery?.stateOfChargeInPercent
        const rangeM = charging.status?.battery?.remainingCruisingRangeInMeters
        const isCharging = charging.status?.state === 'CHARGING'

        // Fetch capacity once (stable per VIN); re-fetch daily if still missing
        if (capacityKWh === undefined) {
          const v = await getVehicleDetails(cfg.vin, accessToken, fetchFn)
          const c = v.specification?.battery?.capacityInKWh
          if (c) capacityKWh = c
        }

        if (soc !== undefined) {
          last = {
            soc,
            batteryCapacity: capacityKWh,
            range: rangeM !== undefined ? rangeM / 1000 : undefined,
            isCharging,
            fetchedAt: new Date(),
          }
          upsertVehicleCache(ctx.db, cfg.name, {
            soc,
            batteryCapacityKWh: capacityKWh,
            range: last.range,
            isCharging,
          })
          lastOkAt = Date.now()
          ctx.log.debug({ soc, isCharging, capacityKWh }, 'skoda poll ok')
          ctx.events.emit('vehicle.poll', { name: cfg.name, soc })
        }
      } catch (err) {
        ctx.log.warn({ err }, 'skoda poll failed')
      }
    }

    return {
      id: cfg.name,

      health() {
        if (auth.deadAuth()) return 'unavailable'
        if (!last) return 'unavailable'
        return Date.now() - lastOkAt < cfg.staleAfterSec * 1000 ? 'ok' : 'degraded'
      },

      async getData(): Promise<VehicleData> {
        if (!last) throw new Error(`vehicle ${cfg.name}: no data yet — first poll in progress`)
        return last
      },

      getCachedCapacity(): number | undefined {
        return capacityKWh
      },

      async start(): Promise<void> {
        // First poll immediately with direct fetch (no jitter at boot)
        void pollOnce(globalThis.fetch)
        // Subsequent polls use ctx.fetch (jitter prevents thundering-herd on restart)
        timer = setInterval(() => void pollOnce(ctx.fetch), Math.max(300, cfg.pollIntervalSec) * 1000)
      },

      async stop(): Promise<void> {
        if (timer) clearInterval(timer)
        await auth.dispose()
      },
    }
  },
})
