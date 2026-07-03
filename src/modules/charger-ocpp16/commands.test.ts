import { test, expect } from 'vitest'
import {
  buildChargingProfilePayload,
  setCurrentLimit,
  remoteStart,
  remoteStop,
  reset,
} from './commands.js'

/** Records the (method, params) of each client.call for assertions. */
function fakeClient() {
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    calls,
    call: async (method: string, params: unknown) => {
      calls.push({ method, params })
      return {}
    },
  }
}

test('buildChargingProfilePayload: TxDefaultProfile/Absolute, limit in Amps', () => {
  const payload = buildChargingProfilePayload(16, 1)
  expect(payload.connectorId).toBe(1)
  expect(payload.csChargingProfiles.chargingProfilePurpose).toBe('TxDefaultProfile')
  expect(payload.csChargingProfiles.chargingProfileKind).toBe('Absolute')
  expect(payload.csChargingProfiles.chargingSchedule.chargingRateUnit).toBe('A')
  expect(payload.csChargingProfiles.chargingSchedule.chargingSchedulePeriod).toEqual([
    { startPeriod: 0, limit: 16 },
  ])
})

test('buildChargingProfilePayload: defaults to connectorId 0 and allows a 0 A limit', () => {
  const payload = buildChargingProfilePayload(0)
  expect(payload.connectorId).toBe(0)
  expect(payload.csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit).toBe(0)
})

test('setCurrentLimit sends SetChargingProfile with the limit in Amps', async () => {
  const client = fakeClient()
  await setCurrentLimit(client, 10, 0)
  expect(client.calls).toHaveLength(1)
  expect(client.calls[0].method).toBe('SetChargingProfile')
  const params = client.calls[0].params as ReturnType<typeof buildChargingProfilePayload>
  expect(params.csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit).toBe(10)
})

test('remoteStart sends RemoteStartTransaction with idTag and connectorId', async () => {
  const client = fakeClient()
  await remoteStart(client, 'osc-auto', 1)
  expect(client.calls[0]).toEqual({
    method: 'RemoteStartTransaction',
    params: { idTag: 'osc-auto', connectorId: 1 },
  })
})

test('remoteStart omits connectorId when not provided', async () => {
  const client = fakeClient()
  await remoteStart(client, 'osc-manual')
  expect(client.calls[0]).toEqual({
    method: 'RemoteStartTransaction',
    params: { idTag: 'osc-manual' },
  })
})

test('remoteStop sends RemoteStopTransaction with the transactionId', async () => {
  const client = fakeClient()
  await remoteStop(client, 42)
  expect(client.calls[0]).toEqual({
    method: 'RemoteStopTransaction',
    params: { transactionId: 42 },
  })
})

test('reset defaults to a Soft reset', async () => {
  const client = fakeClient()
  await reset(client)
  expect(client.calls[0]).toEqual({ method: 'Reset', params: { type: 'Soft' } })
})
