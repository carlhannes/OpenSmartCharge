#!/usr/bin/env node
/**
 * Minimal OCPP 1.6J charger simulator for OSC development and testing.
 *
 * Usage:
 *   node scripts/sim-charger.mjs [options]
 *
 * Options:
 *   --station-id  <id>   Station identifier (default: sim-01)
 *   --url         <url>  OSC WebSocket URL (default: ws://localhost:8080/ocpp)
 *   --connector   <n>    Connector ID to use (default: 1)
 */

import { createFakeCharger } from './lib/fake-charger.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), arr[i + 1]])
    return acc
  }, []),
)

const stationId = args['station-id'] ?? 'sim-01'
const baseUrl = args['url'] ?? 'ws://localhost:8080/ocpp'
const connectorId = Number(args['connector'] ?? 1)

const charger = createFakeCharger(stationId, baseUrl, connectorId)

// Register handlers for outbound commands from OSC
charger.handle('SetChargingProfile', async ({ params }) => {
  const limit = params?.csChargingProfiles?.chargingSchedule?.chargingSchedulePeriod?.[0]?.limit ?? '?'
  console.log(`[sim] SetChargingProfile → limit: ${limit} A on connector ${params?.connectorId ?? 0}`)
  return { status: 'Accepted' }
})

charger.handle('RemoteStartTransaction', async ({ params }) => {
  console.log(`[sim] RemoteStartTransaction → idTag: ${params?.idTag}`)

  // Simulate the charger starting a transaction after a short delay
  setTimeout(async () => {
    try {
      await charger.startTransaction(params?.idTag ?? 'sim')
      console.log(`[sim] StartTransaction acknowledged → transactionId: ${charger.transactionId}`)

      // Send a few meter values
      let energyWh = 0
      const meterInterval = setInterval(async () => {
        energyWh += 1000 // +1 kWh per tick
        await charger.meterValues(energyWh)
        console.log(`[sim] MeterValues → energy: ${energyWh / 1000} kWh`)
      }, 3000)

      // Stop after 3 meter values (~9s)
      setTimeout(async () => {
        clearInterval(meterInterval)
        await charger.stopTransaction(energyWh)
        console.log('[sim] StopTransaction sent')

        await charger.statusNotification('Finishing')
        setTimeout(async () => {
          await charger.statusNotification('Available')
          console.log('[sim] Back to Available')
        }, 1000)
      }, 10_000)
    } catch (err) {
      console.error('[sim] StartTransaction error:', err.message)
    }
  }, 500)

  return { status: 'Accepted' }
})

charger.handle('RemoteStopTransaction', async ({ params }) => {
  console.log(`[sim] RemoteStopTransaction → transactionId: ${params?.transactionId}`)
  return { status: 'Accepted' }
})

charger.handle('Reset', async ({ params }) => {
  console.log(`[sim] Reset → type: ${params?.type}`)
  return { status: 'Accepted' }
})

async function run() {
  console.log(`[sim] Connecting to ${charger.url} as ${stationId}`)
  await charger.connect()
  console.log('[sim] Connected')

  const boot = await charger.boot()
  console.log('[sim] BootNotification response:', boot)

  await charger.heartbeat()

  await charger.statusNotification('Available')
  console.log(`[sim] StatusNotification → Available on connector ${connectorId}`)

  // Simulate a vehicle plugging in after 2s
  setTimeout(async () => {
    await charger.statusNotification('Preparing')
    console.log('[sim] StatusNotification → Preparing (vehicle plugged in)')
  }, 2000)

  // Keep alive with heartbeats
  setInterval(async () => {
    await charger.heartbeat()
  }, 30_000)
}

run().catch((err) => {
  console.error('[sim] Fatal error:', err.message)
  process.exit(1)
})
