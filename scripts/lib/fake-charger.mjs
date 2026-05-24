// Minimal OCPP 1.6J charger stub for smoke testing and simulations.
// Returns a thin wrapper around an RPCClient with named per-operation methods.

import pkg from 'ocpp-rpc'
const { RPCClient } = pkg

/**
 * @param {string} stationId
 * @param {string} [baseUrl]
 * @param {number} [connectorId]
 */
export function createFakeCharger(stationId, baseUrl = 'ws://localhost:8080/ocpp', connectorId = 1) {
  const url = `${baseUrl}/${stationId}`
  const client = new RPCClient({
    endpoint: url,
    identity: stationId,
    protocols: ['ocpp1.6'],
    strictMode: false,
  })

  const charger = {
    client,
    connectorId,
    stationId,
    url,
    transactionId: null,

    handle(method, handler) {
      client.handle(method, handler)
    },

    async connect() {
      await client.connect()
    },

    async boot() {
      return client.call('BootNotification', {
        chargePointVendor: 'SimVendor',
        chargePointModel: 'SimModel',
        chargePointSerialNumber: 'SIM-0001',
        firmwareVersion: '1.0.0',
      })
    },

    async heartbeat() {
      return client.call('Heartbeat', {}).catch(() => {})
    },

    async statusNotification(status, errorCode = 'NoError') {
      return client.call('StatusNotification', {
        connectorId,
        errorCode,
        status,
        timestamp: new Date().toISOString(),
      })
    },

    async startTransaction(idTag = 'sim', meterStart = 0) {
      const result = await client.call('StartTransaction', {
        connectorId,
        idTag,
        meterStart,
        timestamp: new Date().toISOString(),
      })
      charger.transactionId = result?.transactionId ?? null
      return result
    },

    async meterValues(energyWh, powerW = 7400, currentA = 32) {
      return client.call('MeterValues', {
        connectorId,
        transactionId: charger.transactionId,
        meterValue: [{
          timestamp: new Date().toISOString(),
          sampledValue: [
            { measurand: 'Energy.Active.Import.Register', value: String(energyWh), unit: 'Wh' },
            { measurand: 'Power.Active.Import', value: String(powerW), unit: 'W' },
            { measurand: 'Current.Import', value: String(currentA), unit: 'A' },
          ],
        }],
      })
    },

    async stopTransaction(meterStop = 0) {
      if (charger.transactionId == null) throw new Error('no active transaction')
      const result = await client.call('StopTransaction', {
        transactionId: charger.transactionId,
        meterStop,
        timestamp: new Date().toISOString(),
        reason: 'Local',
      })
      charger.transactionId = null
      return result
    },

    async close() {
      await client.close().catch(() => {})
    },
  }

  return charger
}
