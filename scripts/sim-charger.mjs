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

import pkg from 'ocpp-rpc'
const { RPCClient } = pkg

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), arr[i + 1]])
    return acc
  }, []),
)

const stationId = args['station-id'] ?? 'sim-01'
const baseUrl = args['url'] ?? 'ws://localhost:8080/ocpp'
const connectorId = Number(args['connector'] ?? 1)
const url = `${baseUrl}/${stationId}`

const client = new RPCClient({
  endpoint: url,
  identity: stationId,
  protocols: ['ocpp1.6'],
  strictMode: false,
})

let transactionId = null

// Register handlers for outbound commands from OSC
client.handle('SetChargingProfile', async ({ params }) => {
  const limit = params?.csChargingProfiles?.chargingSchedule?.chargingSchedulePeriod?.[0]?.limit ?? '?'
  console.log(`[sim] SetChargingProfile → limit: ${limit} A on connector ${params?.connectorId ?? 0}`)
  return { status: 'Accepted' }
})

client.handle('RemoteStartTransaction', async ({ params }) => {
  console.log(`[sim] RemoteStartTransaction → idTag: ${params?.idTag}`)

  // Simulate the charger starting a transaction after a short delay
  setTimeout(async () => {
    try {
      const result = await client.call('StartTransaction', {
        connectorId,
        idTag: params?.idTag ?? 'sim',
        meterStart: 0,
        timestamp: new Date().toISOString(),
      })
      transactionId = result?.transactionId ?? null
      console.log(`[sim] StartTransaction acknowledged → transactionId: ${transactionId}`)

      // Send a few meter values
      let energyWh = 0
      const meterInterval = setInterval(async () => {
        energyWh += 1000 // +1 kWh per tick
        await client.call('MeterValues', {
          connectorId,
          transactionId,
          meterValue: [
            {
              timestamp: new Date().toISOString(),
              sampledValue: [
                { measurand: 'Energy.Active.Import.Register', value: String(energyWh), unit: 'Wh' },
                { measurand: 'Power.Active.Import', value: '7400', unit: 'W' },
                { measurand: 'Current.Import', value: '32', unit: 'A' },
              ],
            },
          ],
        })
        console.log(`[sim] MeterValues → energy: ${energyWh / 1000} kWh`)
      }, 3000)

      // Stop after 3 meter values
      setTimeout(async () => {
        clearInterval(meterInterval)
        await client.call('StopTransaction', {
          transactionId,
          meterStop: energyWh,
          timestamp: new Date().toISOString(),
          reason: 'Local',
        })
        console.log('[sim] StopTransaction sent')
        transactionId = null

        await client.call('StatusNotification', {
          connectorId,
          errorCode: 'NoError',
          status: 'Finishing',
          timestamp: new Date().toISOString(),
        })
        setTimeout(async () => {
          await client.call('StatusNotification', {
            connectorId,
            errorCode: 'NoError',
            status: 'Available',
            timestamp: new Date().toISOString(),
          })
          console.log('[sim] Back to Available')
        }, 1000)
      }, 10_000)
    } catch (err) {
      console.error('[sim] StartTransaction error:', err.message)
    }
  }, 500)

  return { status: 'Accepted' }
})

client.handle('RemoteStopTransaction', async ({ params }) => {
  console.log(`[sim] RemoteStopTransaction → transactionId: ${params?.transactionId}`)
  return { status: 'Accepted' }
})

client.handle('Reset', async ({ params }) => {
  console.log(`[sim] Reset → type: ${params?.type}`)
  return { status: 'Accepted' }
})

async function run() {
  console.log(`[sim] Connecting to ${url} as ${stationId}`)
  await client.connect()
  console.log('[sim] Connected')

  // BootNotification
  const boot = await client.call('BootNotification', {
    chargePointVendor: 'SimVendor',
    chargePointModel: 'SimModel',
    chargePointSerialNumber: 'SIM-0001',
    firmwareVersion: '1.0.0',
  })
  console.log('[sim] BootNotification response:', boot)

  // Heartbeat
  await client.call('Heartbeat', {})

  // StatusNotification: Available
  await client.call('StatusNotification', {
    connectorId,
    errorCode: 'NoError',
    status: 'Available',
    timestamp: new Date().toISOString(),
  })
  console.log(`[sim] StatusNotification → Available on connector ${connectorId}`)

  // Simulate a vehicle plugging in after 2s
  setTimeout(async () => {
    await client.call('StatusNotification', {
      connectorId,
      errorCode: 'NoError',
      status: 'Preparing',
      timestamp: new Date().toISOString(),
    })
    console.log(`[sim] StatusNotification → Preparing (vehicle plugged in)`)
  }, 2000)

  // Keep alive with heartbeats
  setInterval(async () => {
    await client.call('Heartbeat', {}).catch(() => {})
  }, 30_000)
}

run().catch((err) => {
  console.error('[sim] Fatal error:', err.message)
  process.exit(1)
})
