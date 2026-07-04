import { registerVehicle } from '../../sdk/registry-api.js'
import type { VehicleData } from '../../sdk/vehicle.js'
import { parseConfig } from './types.js'
import { upsertVehicleCache, loadVehicleCache } from './persistence.js'
import { getVehicleDetails, getChargingStatus, getAirConditioning } from './api.js'
import { createAuthClient } from './auth.js'

// Climate/preconditioning states that count as "active" (the car is heating/cooling).
const CLIMATE_ACTIVE = new Set(['HEATING', 'HEATING_AUXILIARY', 'COOLING', 'VENTILATION', 'ON'])

registerVehicle({
  type: 'skoda',

  create(rawCfg, ctx) {
    const cfg = parseConfig(rawCfg)

    let last: VehicleData | null = loadVehicleCache(ctx.db, cfg.name)
    let capacityKWh: number | undefined = last?.batteryCapacity

    const auth = createAuthClient(cfg, ctx)

    // One live fetch → update the cache → return the fresh data. The LIFECYCLE decides when to
    // call this (on charger-connect + periodically during charging); this module owns no polling
    // timer of its own. Throws on failure — the caller keeps the last cached value.
    async function refresh(): Promise<VehicleData> {
      const accessToken = await auth.token()

      // Charging status is the primary read; air-conditioning (plug + climate) is best-effort.
      const [charging, airCon] = await Promise.all([
        getChargingStatus(cfg.vin, accessToken, ctx.fetch),
        getAirConditioning(cfg.vin, accessToken, ctx.fetch).catch(() => undefined),
      ])

      const soc = charging.status?.battery?.stateOfChargeInPercent
      if (soc === undefined) throw new Error(`vehicle ${cfg.name}: no SoC in charging response`)

      // Battery capacity is stable per VIN — fetch once, then reuse.
      if (capacityKWh === undefined) {
        const v = await getVehicleDetails(cfg.vin, accessToken, ctx.fetch)
        const c = v.specification?.battery?.capacityInKWh
        if (c) capacityKWh = c
      }

      const rangeM = charging.status?.battery?.remainingCruisingRangeInMeters
      const data: VehicleData = {
        soc,
        batteryCapacity: capacityKWh,
        range: rangeM !== undefined ? rangeM / 1000 : undefined,
        isCharging: charging.status?.state === 'CHARGING',
        state: charging.status?.state,
        targetSoc: charging.settings?.targetStateOfChargeInPercent,
        chargePowerKw: charging.status?.chargePowerInKw,
        remainingChargeMinutes: charging.status?.remainingTimeToFullyChargedInMinutes,
        pluggedIn: airCon ? airCon.chargerConnectionState === 'CONNECTED' : undefined,
        climateActive: airCon ? CLIMATE_ACTIVE.has(airCon.state ?? '') : undefined,
        fetchedAt: new Date(),
      }
      last = data
      upsertVehicleCache(ctx.db, cfg.name, {
        soc,
        batteryCapacityKWh: capacityKWh,
        range: data.range,
        isCharging: data.isCharging,
      })
      ctx.log.debug(
        { soc, isCharging: data.isCharging, pluggedIn: data.pluggedIn, targetSoc: data.targetSoc },
        'skoda refresh ok',
      )
      ctx.events.emit('vehicle.poll', { name: cfg.name, soc })
      return data
    }

    return {
      id: cfg.name,

      refresh,

      async getData(): Promise<VehicleData> {
        if (!last) throw new Error(`vehicle ${cfg.name}: no data yet`)
        return last
      },

      getCachedCapacity(): number | undefined {
        return capacityKWh
      },

      // Demand-polled, so staleness while idle is expected — health only reflects whether we
      // CAN get data: unavailable if auth is dead or we have nothing cached yet, else ok.
      health() {
        if (auth.deadAuth() || !last) return 'unavailable'
        return 'ok'
      },

      async stop(): Promise<void> {
        await auth.dispose()
      },
    }
  },
})
