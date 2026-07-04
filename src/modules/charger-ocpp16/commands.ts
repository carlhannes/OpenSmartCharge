import type {
  SetChargingProfileReq,
  RemoteStartTransactionReq,
  RemoteStopTransactionReq,
} from './types.js'

type Client = { call(method: string, params: unknown): Promise<unknown> }

export function buildChargingProfilePayload(
  limitA: number,
  connectorId = 0,
  stackLevel = 1,
  numberPhases = 3,
): SetChargingProfileReq {
  return {
    connectorId,
    csChargingProfiles: {
      chargingProfileId: 1,
      stackLevel,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        // Backdate 60s so the Absolute schedule's period is already active regardless of
        // clock skew between server and charger — otherwise some chargers (Zaptec) treat the
        // limit as "not yet started", offer 0A, and sit in SuspendedEVSE. (Matches evcc.)
        startSchedule: new Date(Date.now() - 60_000).toISOString(),
        chargingRateUnit: 'A',
        // numberPhases: some chargers (Zaptec) offer 0A / stay SuspendedEVSE when it's omitted,
        // even though OCPP says it defaults to 3. Sourced from the charger's `phases` config.
        chargingSchedulePeriod: [{ startPeriod: 0, limit: limitA, numberPhases }],
      },
    },
  }
}

export async function setCurrentLimit(
  client: Client,
  amps: number,
  connectorId = 0,
  stackLevel = 1,
  numberPhases = 3,
): Promise<{ status?: string }> {
  return (await client.call(
    'SetChargingProfile',
    buildChargingProfilePayload(amps, connectorId, stackLevel, numberPhases),
  )) as { status?: string }
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

export async function reset(
  client: Client,
  type: 'Soft' | 'Hard' = 'Soft',
): Promise<{ status?: string }> {
  return (await client.call('Reset', { type })) as { status?: string }
}

export async function changeAvailability(
  client: Client,
  connectorId: number,
  type: 'Operative' | 'Inoperative' = 'Operative',
): Promise<{ status?: string }> {
  return (await client.call('ChangeAvailability', { connectorId, type })) as { status?: string }
}

// Clear installed charging profiles. With no filter, clears ALL profiles — used on takeover
// to wipe a previous central system's leftovers (e.g. a 0 A profile at a high stack level that
// would otherwise outrank ours; Zaptec persists stacked profiles across CS reconnects).
export async function clearChargingProfile(client: Client): Promise<{ status?: string }> {
  return (await client.call('ClearChargingProfile', {})) as { status?: string }
}

export interface CompositeScheduleResp {
  status?: string
  connectorId?: number
  scheduleStart?: string
  chargingSchedule?: {
    chargingRateUnit?: string
    chargingSchedulePeriod?: Array<{ startPeriod: number; limit: number; numberPhases?: number }>
  }
}

// Ask the charger what current limit it actually computes right now (the composite of all
// active profiles). Definitive way to see whether our profile is winning the stack.
export async function getCompositeSchedule(
  client: Client,
  connectorId: number,
  duration: number,
): Promise<CompositeScheduleResp> {
  return (await client.call('GetCompositeSchedule', {
    connectorId,
    duration,
  })) as CompositeScheduleResp
}

export interface ConfigurationResp {
  configurationKey?: Array<{ key: string; readonly?: boolean; value?: string }>
  unknownKey?: string[]
}

export async function getConfiguration(client: Client, keys?: string[]): Promise<ConfigurationResp> {
  return (await client.call('GetConfiguration', keys ? { key: keys } : {})) as ConfigurationResp
}

// Ask the charger to (re)send a message, e.g. StatusNotification after a reconnect — chargers
// don't re-send BootNotification/StatusNotification on a bare WS reconnect.
export async function triggerMessage(
  client: Client,
  requestedMessage: string,
  connectorId?: number,
): Promise<{ status?: string }> {
  const params: Record<string, unknown> = { requestedMessage }
  if (connectorId !== undefined) params.connectorId = connectorId
  return (await client.call('TriggerMessage', params)) as { status?: string }
}
