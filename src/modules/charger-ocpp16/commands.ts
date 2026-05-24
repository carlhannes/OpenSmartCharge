import type { SetChargingProfileReq, RemoteStartTransactionReq, RemoteStopTransactionReq } from './types.js'

type Client = { call(method: string, params: unknown): Promise<unknown> }

export function buildChargingProfilePayload(limitA: number, connectorId = 0): SetChargingProfileReq {
  return {
    connectorId,
    csChargingProfiles: {
      chargingProfileId: 1,
      stackLevel: 1,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        startSchedule: new Date().toISOString(),
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: limitA }],
      },
    },
  }
}

export async function setCurrentLimit(client: Client, amps: number, connectorId = 0): Promise<void> {
  await client.call('SetChargingProfile', buildChargingProfilePayload(amps, connectorId))
}

export async function remoteStart(
  client: Client,
  idTag: string,
  connectorId?: number,
): Promise<void> {
  const params: RemoteStartTransactionReq = { idTag }
  if (connectorId !== undefined) params.connectorId = connectorId
  await client.call('RemoteStartTransaction', params)
}

export async function remoteStop(client: Client, transactionId: number): Promise<void> {
  const params: RemoteStopTransactionReq = { transactionId }
  await client.call('RemoteStopTransaction', params)
}

export async function reset(client: Client, type: 'Soft' | 'Hard' = 'Soft'): Promise<void> {
  await client.call('Reset', { type })
}
