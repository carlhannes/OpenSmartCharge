// A typed mock OCPP 1.6J charger for integration tests. Unlike the dumb transport in
// scripts/lib/fake-charger.mjs (static responses), this models the *behavior* real chargers
// have and that our tests must reproduce — most importantly Zaptec's stacked charging
// profiles (highest stackLevel wins) and profile persistence. It answers every command the
// OcppServer sends, tracks a profile stack + composite limit, and records inbound commands
// for assertions. Tests drive status/transactions/meter values explicitly for determinism.
//
// NOTE: this lives under src/ (so tests import it without .mjs typing friction) — it's test
// support, not shipped runtime. See ROADMAP: exclude *.test.ts + test support from `dist`.

import { RPCClient } from 'ocpp-rpc'

// Minimal typed view of the ocpp-rpc client (mirrors the OcppClient pattern in server.ts).
interface RpcClientLike {
  connect(): Promise<void>
  call(method: string, params?: unknown): Promise<Record<string, unknown>>
  handle(method: string, handler: (evt: { params?: unknown }) => unknown | Promise<unknown>): void
  close(opts?: unknown): Promise<void>
}

export interface SeedProfile {
  connectorId?: number
  stackLevel: number
  purpose?: string
  chargingProfileId: number
  limit: number
}

export interface MockChargerOptions {
  connectorId?: number
  /** ChargeProfileMaxStackLevel reported via GetConfiguration (default 8, like Zaptec native). */
  maxStackLevel?: number
  /** MaxChargingProfilesInstalled reported via GetConfiguration (default 24). */
  maxProfiles?: number
  /** Limit the charger offers when no profile is installed (default 32). */
  hardwareDefaultA?: number
  /** Pre-installed profiles — reproduce a leftover profile from a previous central system. */
  seedProfiles?: SeedProfile[]
}

interface InstalledProfile {
  connectorId: number
  stackLevel: number
  purpose: string
  chargingProfileId: number
  limit: number
}

export interface MockCharger {
  readonly stationId: string
  readonly url: string
  readonly connectorId: number
  /** every inbound (CS→charger) command, for assertions. */
  readonly received: Array<{ method: string; params: Record<string, unknown> }>
  /** status the charger reports when the CS sends TriggerMessage(StatusNotification). */
  status: string
  transactionId: number | null
  connect(): Promise<void>
  close(): Promise<void>
  boot(): Promise<Record<string, unknown>>
  heartbeat(): Promise<void>
  statusNotification(status: string, errorCode?: string): Promise<Record<string, unknown>>
  startTransaction(idTag?: string, meterStart?: number): Promise<{ transactionId?: number }>
  /** Send MeterValues. Per-phase Current.Import + Power + Energy register + Current.Offered. */
  meterValues(v: {
    energyWh?: number
    powerW?: number
    currentA?: number
    offeredA?: number
    phases?: number
  }): Promise<Record<string, unknown>>
  stopTransaction(meterStop?: number): Promise<Record<string, unknown>>
  /** composite offered limit = limit of the highest active stackLevel (what a real charger would offer). */
  composite(connectorId?: number): number
  countReceived(method: string): number
}

export function createMockCharger(
  stationId: string,
  wsBaseUrl: string,
  opts: MockChargerOptions = {},
): MockCharger {
  const connectorId = opts.connectorId ?? 1
  const maxStackLevel = opts.maxStackLevel ?? 8
  const maxProfiles = opts.maxProfiles ?? 24
  const hardwareDefaultA = opts.hardwareDefaultA ?? 32
  const url = `${wsBaseUrl}/${stationId}`

  // ocpp-rpc's RPC_ClientOptions type marks all fields required, but the library supplies
  // defaults (reconnect, timeouts, …) — the same 4 fields the .mjs sim passes are enough.
  const rpc = new RPCClient({
    endpoint: url,
    identity: stationId,
    protocols: ['ocpp1.6'],
    strictMode: false,
  } as unknown as ConstructorParameters<typeof RPCClient>[0])
  const client = rpc as unknown as RpcClientLike

  const profiles: InstalledProfile[] = (opts.seedProfiles ?? []).map((p) => ({
    connectorId: p.connectorId ?? 0,
    purpose: p.purpose ?? 'TxDefaultProfile',
    stackLevel: p.stackLevel,
    chargingProfileId: p.chargingProfileId,
    limit: p.limit,
  }))
  const received: Array<{ method: string; params: Record<string, unknown> }> = []
  const rec = (method: string, params: unknown) =>
    received.push({ method, params: (params ?? {}) as Record<string, unknown> })

  function composite(conn = connectorId): number {
    const applicable = profiles.filter((p) => p.connectorId === 0 || p.connectorId === conn)
    if (applicable.length === 0) return hardwareDefaultA
    return applicable.reduce((top, p) => (p.stackLevel >= top.stackLevel ? p : top)).limit
  }

  const charger: MockCharger = {
    stationId,
    url,
    connectorId,
    received,
    status: 'Preparing',
    transactionId: null,
    composite,
    countReceived: (method) => received.filter((r) => r.method === method).length,

    async connect() {
      await client.connect()
    },
    async close() {
      await client.close({ force: true }).catch(() => {})
    },
    async boot() {
      return client.call('BootNotification', {
        chargePointVendor: 'MockVendor',
        chargePointModel: 'MockModel',
        chargePointSerialNumber: stationId,
        firmwareVersion: '1.0.0',
      })
    },
    async heartbeat() {
      await client.call('Heartbeat', {}).catch(() => {})
    },
    async statusNotification(status, errorCode = 'NoError') {
      return client.call('StatusNotification', {
        connectorId,
        errorCode,
        status,
        timestamp: new Date().toISOString(),
      })
    },
    async startTransaction(idTag = 'mock', meterStart = 0) {
      const result = (await client.call('StartTransaction', {
        connectorId,
        idTag,
        meterStart,
        timestamp: new Date().toISOString(),
      })) as { transactionId?: number }
      charger.transactionId = result?.transactionId ?? null
      return result
    },
    async meterValues(v) {
      const phases = v.phases ?? 3
      const sampledValue: Array<Record<string, string>> = []
      if (v.powerW !== undefined)
        sampledValue.push({ measurand: 'Power.Active.Import', value: String(v.powerW), unit: 'W' })
      if (v.energyWh !== undefined)
        sampledValue.push({
          measurand: 'Energy.Active.Import.Register',
          value: String(v.energyWh),
          unit: 'Wh',
        })
      if (v.currentA !== undefined)
        for (const phase of ['L1', 'L2', 'L3'].slice(0, phases))
          sampledValue.push({
            measurand: 'Current.Import',
            phase,
            value: String(v.currentA),
            unit: 'A',
          })
      if (v.offeredA !== undefined)
        sampledValue.push({ measurand: 'Current.Offered', value: String(v.offeredA), unit: 'A' })
      return client.call('MeterValues', {
        connectorId,
        transactionId: charger.transactionId ?? undefined,
        meterValue: [{ timestamp: new Date().toISOString(), sampledValue }],
      })
    },
    async stopTransaction(meterStop = 0) {
      const result = await client.call('StopTransaction', {
        transactionId: charger.transactionId,
        meterStop,
        timestamp: new Date().toISOString(),
        reason: 'Local',
      })
      charger.transactionId = null
      return result
    },
  }

  // ── Command handlers (CS → charger). Modeling the profile stack is the point. ──
  client.handle('GetConfiguration', (evt) => {
    rec('GetConfiguration', evt.params)
    return {
      configurationKey: [
        { key: 'ChargeProfileMaxStackLevel', readonly: true, value: String(maxStackLevel) },
        { key: 'MaxChargingProfilesInstalled', readonly: true, value: String(maxProfiles) },
      ],
      unknownKey: [],
    }
  })

  client.handle('SetChargingProfile', (evt) => {
    rec('SetChargingProfile', evt.params)
    const p = evt.params as {
      connectorId?: number
      csChargingProfiles?: {
        stackLevel?: number
        chargingProfilePurpose?: string
        chargingProfileId?: number
        chargingSchedule?: { chargingSchedulePeriod?: Array<{ limit?: number }> }
      }
    }
    const cp = p.csChargingProfiles ?? {}
    const entry: InstalledProfile = {
      connectorId: p.connectorId ?? 0,
      stackLevel: cp.stackLevel ?? 0,
      purpose: cp.chargingProfilePurpose ?? 'TxDefaultProfile',
      chargingProfileId: cp.chargingProfileId ?? 0,
      limit: cp.chargingSchedule?.chargingSchedulePeriod?.[0]?.limit ?? 0,
    }
    // OCPP: replace on same chargingProfileId OR same (connectorId, stackLevel, purpose).
    const idx = profiles.findIndex(
      (x) =>
        x.chargingProfileId === entry.chargingProfileId ||
        (x.connectorId === entry.connectorId &&
          x.stackLevel === entry.stackLevel &&
          x.purpose === entry.purpose),
    )
    if (idx >= 0) profiles[idx] = entry
    else profiles.push(entry)
    return { status: 'Accepted' }
  })

  client.handle('ClearChargingProfile', (evt) => {
    rec('ClearChargingProfile', evt.params)
    const f = (evt.params ?? {}) as {
      id?: number
      connectorId?: number
      chargingProfilePurpose?: string
      stackLevel?: number
    }
    const before = profiles.length
    for (let i = profiles.length - 1; i >= 0; i--) {
      const p = profiles[i]
      if (
        (f.id == null || p.chargingProfileId === f.id) &&
        (f.connectorId == null || p.connectorId === f.connectorId) &&
        (f.chargingProfilePurpose == null || p.purpose === f.chargingProfilePurpose) &&
        (f.stackLevel == null || p.stackLevel === f.stackLevel)
      )
        profiles.splice(i, 1)
    }
    return { status: profiles.length < before ? 'Accepted' : 'Unknown' }
  })

  client.handle('GetCompositeSchedule', (evt) => {
    rec('GetCompositeSchedule', evt.params)
    const conn = (evt.params as { connectorId?: number }).connectorId ?? connectorId
    return {
      status: 'Accepted',
      connectorId: conn,
      scheduleStart: new Date().toISOString(),
      chargingSchedule: {
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: composite(conn) }],
      },
    }
  })

  client.handle('ChangeAvailability', (evt) => {
    rec('ChangeAvailability', evt.params)
    return { status: 'Accepted' }
  })
  client.handle('Reset', (evt) => {
    rec('Reset', evt.params)
    return { status: 'Accepted' }
  })
  client.handle('RemoteStartTransaction', (evt) => {
    rec('RemoteStartTransaction', evt.params)
    return { status: 'Accepted' }
  })
  client.handle('RemoteStopTransaction', (evt) => {
    rec('RemoteStopTransaction', evt.params)
    return { status: 'Accepted' }
  })
  client.handle('TriggerMessage', (evt) => {
    rec('TriggerMessage', evt.params)
    if ((evt.params as { requestedMessage?: string })?.requestedMessage === 'StatusNotification') {
      setImmediate(() => void charger.statusNotification(charger.status).catch(() => {}))
    }
    return { status: 'Accepted' }
  })

  return charger
}
