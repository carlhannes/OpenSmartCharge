import { registerVehicle } from '../../sdk/registry-api.js'
import type { VehicleData } from '../../sdk/vehicle.js'
import { sourceHealth } from '../../core/source-reconciler.js'
import { parseConfig } from './types.js'
import { upsertVehicleCache, loadVehicleCache } from './persistence.js'
import {
  getVehicleDetails,
  getChargingStatus,
  getAirConditioning,
  startCharging as apiStartCharging,
  stopCharging as apiStopCharging,
} from './api.js'
import { createAuthClient } from './auth.js'

// Climate/preconditioning states that count as "active" (the car is heating/cooling).
const CLIMATE_ACTIVE = new Set(['HEATING', 'HEATING_AUXILIARY', 'COOLING', 'VENTILATION', 'ON'])

registerVehicle({
  type: 'skoda',

  create(rawCfg, ctx) {
    const cfg = parseConfig(rawCfg)

    let last: VehicleData | null = loadVehicleCache(ctx.db, cfg.name)
    let capacityKWh: number | undefined = last?.batteryCapacity
    // Consecutive failed refreshes (any throw — auth, HTTP, or missing SoC). Reset on success.
    // Drives a staleness/failure-aware health() so a data outage (403/500 loop) is VISIBLE, rather
    // than a non-null stale cache reporting `ok` forever (the 10 h silent outage we hit overnight).
    let consecutiveFailures = 0

    const auth = createAuthClient(cfg, ctx)

    // One live fetch → update the cache → return the fresh data. The LIFECYCLE decides when to
    // call this (on charger-connect + periodically during charging); this module owns no polling
    // timer of its own. Throws on failure — the caller keeps the last cached value.
    async function refresh(): Promise<VehicleData> {
      try {
        const accessToken = await auth.token()

        // Vehicle reads use the global `fetch`, NOT ctx.fetch: this is a demand-driven, time-sensitive
        // poll (triggered on charger-connect / during charging), so it must return promptly. ctx.fetch's
        // 0–120 s anti-thundering-herd jitter is only for public, non-urgent scheduled data (tariffs).
        // Charging status is the primary read; air-conditioning (plug + climate) is best-effort.
        const [charging, airCon] = await Promise.all([
          getChargingStatus(cfg.vin, accessToken, fetch),
          getAirConditioning(cfg.vin, accessToken, fetch).catch(() => undefined),
        ])

        const soc = charging.status?.battery?.stateOfChargeInPercent
        if (soc === undefined) throw new Error(`vehicle ${cfg.name}: no SoC in charging response`)

        // Battery capacity is stable per VIN — fetch once, then reuse.
        if (capacityKWh === undefined) {
          const v = await getVehicleDetails(cfg.vin, accessToken, fetch)
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
          targetSoc: data.targetSoc,
          pluggedIn: data.pluggedIn,
          climateActive: data.climateActive,
        })
        ctx.log.debug(
          {
            soc,
            isCharging: data.isCharging,
            pluggedIn: data.pluggedIn,
            targetSoc: data.targetSoc,
          },
          'skoda refresh ok',
        )
        ctx.events.emit('vehicle.poll', { name: cfg.name, soc })
        consecutiveFailures = 0
        return data
      } catch (err) {
        consecutiveFailures++
        throw err
      }
    }

    return {
      id: cfg.name,

      refresh,

      // Lifecycle post-startup hook: one status-sync poll after a (re)start so an ALREADY-plugged car
      // is detected even when the charger reports the connector `Available` (it won't re-announce a
      // car plugged before OSC connected). One-shot — the ongoing cadence (shouldPollVehicle) is
      // unchanged, so a genuinely-unplugged car is polled once here and then left alone. May throw;
      // the lifecycle retries with backoff.
      async postStartup(): Promise<void> {
        await refresh()
      },

      async getData(): Promise<VehicleData> {
        if (!last) throw new Error(`vehicle ${cfg.name}: no data yet`)
        return last
      },

      getCachedCapacity(): number | undefined {
        return capacityKWh
      },

      // Car-side start/stop. Uses the plain global `fetch` (prompt, like refresh) — this is a
      // time-sensitive recovery action, not scheduled public data. Throws on failure so the
      // SessionReconciler can see it didn't take and fall back to its other levers.
      async startCharging(): Promise<void> {
        const accessToken = await auth.token()
        await apiStartCharging(cfg.vin, accessToken, fetch)
        ctx.log.info({ vehicle: cfg.name }, 'skoda start-charge sent')
      },

      async stopCharging(): Promise<void> {
        const accessToken = await auth.token()
        await apiStopCharging(cfg.vin, accessToken, fetch)
        ctx.log.info({ vehicle: cfg.name }, 'skoda stop-charge sent')
      },

      // Demand-polled, so wall-clock staleness while idle is EXPECTED (we don't wake a parked car) —
      // health keys off recent failures, not age. Hard-down when auth is dead or nothing is cached
      // yet; a run of failed polls (a data 403/500 loop) degrades then goes unavailable, so an
      // outage surfaces instead of a stale cache reading `ok` forever.
      health() {
        return sourceHealth({ consecutiveFailures, hardDown: auth.deadAuth() || !last })
      },

      async stop(): Promise<void> {
        await auth.dispose()
      },
    }
  },
})
