import { RPCServer, createRPCError } from 'ocpp-rpc'
import type { DatabaseSync } from 'node:sqlite'
import type { Logger } from 'pino'
import type { ChargerStatus } from '../../sdk/charger.js'
import type { ModuleHealth } from '../../sdk/types.js'

// Minimal interface for an ocpp-rpc server client (subset we actually use).
// Two overloads mirror ocpp-rpc's own handle() signature to ensure contextual
// typing flows through to each callback's `{ params }` destructuring.
interface OcppClient {
  readonly handshake: { identity: string }
  call(method: string, params?: unknown): Promise<unknown>
  handle(
    method: string,
    handler: (event: { params?: unknown }) => Promise<Record<string, unknown>>,
  ): void
  handle(
    handler: (event: { method?: string; params?: unknown }) => Promise<Record<string, unknown>>,
  ): void
  on(event: string, listener: (...args: unknown[]) => void): this
}
import type {
  BootNotificationReq,
  StatusNotificationReq,
  MeterValuesReq,
  StartTransactionReq,
  StopTransactionReq,
} from './types.js'
import {
  allocateTransactionId,
  insertTransaction,
  finishTransaction,
  insertMeterValues,
  latestEnergyKwh,
  findOpenTransaction,
} from './persistence.js'
import {
  setCurrentLimit,
  remoteStart,
  remoteStop as cmdRemoteStop,
  reset as cmdReset,
  changeAvailability,
  clearChargingProfile as cmdClearChargingProfile,
  getCompositeSchedule as cmdGetCompositeSchedule,
  getConfiguration as cmdGetConfiguration,
  triggerMessage as cmdTriggerMessage,
  type CompositeScheduleResp,
} from './commands.js'
import { computeConnectionState, shouldAutoStartTransaction, computeHealth } from './status.js'
import { latestReadings } from './meter-parser.js'

type StatusCallback = (status: ChargerStatus) => void

/** A charger that has connected over OCPP but isn't registered from config yet — awaiting a claim. */
export interface PendingStation {
  stationId: string
  vendor?: string
  model?: string
  status?: string
  connectedAt: string
}

interface StationState {
  client: OcppClient
  activeTransactionId?: number
  connectorId: number
  statusCallbacks: Set<StatusCallback>
  autoStartTransaction: boolean
}

export class OcppServer {
  private readonly rpcServer: RPCServer
  readonly handleUpgrade: RPCServer['handleUpgrade']
  private readonly stations = new Map<string, StationState>()
  private readonly _pendingAutoStart = new Map<string, boolean>()
  // Status subscriptions persist across reconnects (keyed by stationId) so a charger that
  // drops + reconnects keeps notifying the loadpoint.
  private readonly statusSubs = new Map<string, Set<StatusCallback>>()
  // Last commanded amps + discovered max stack level per station — survive reconnects so we
  // re-assert the right limit at the right stack level when a dropped socket returns.
  private readonly lastLimitByStation = new Map<string, number>()
  private readonly maxStackByStation = new Map<string, number>()
  // Per-charger phase count (from config), sent as numberPhases in the charging profile.
  private readonly phasesByStation = new Map<string, number>()
  // Connection info for any connected station (vendor/model/status), for the "pending unclaimed
  // charger" flow. Populated on connect + BootNotification + StatusNotification.
  private readonly pendingInfo = new Map<
    string,
    { vendor?: string; model?: string; lastStatus?: string; firstSeenAt: Date }
  >()

  constructor(
    private readonly db: DatabaseSync,
    private readonly log: Logger,
    private readonly defaultBootCurrentA: number,
  ) {
    this.rpcServer = new RPCServer({
      protocols: ['ocpp1.6'],
      strictMode: false, // Many chargers send non-strictly-valid messages; be lenient
      callTimeoutMs: 30_000,
    })

    this.handleUpgrade = this.rpcServer.handleUpgrade.bind(this.rpcServer)

    this.rpcServer.auth((accept) => {
      accept()
    })

    this.rpcServer.on('client', (client) => {
      void this.attachClient(client as OcppClient)
    })

    this.rpcServer.on('error', (err: unknown) => {
      this.log.error({ err }, 'OCPP server error')
    })
  }

  private readonly _loadpointNames = new Map<string, string>()

  registerStation(stationId: string, autoStartTransaction: boolean): void {
    this._pendingAutoStart.set(stationId, autoStartTransaction)
    // If the station is ALREADY connected (claiming an unclaimed charger), update its live flag too —
    // otherwise the value captured at connect (false for unclaimed) sticks until the next reconnect.
    const s = this.stations.get(stationId)
    if (s) s.autoStartTransaction = autoStartTransaction
    this.log.debug({ stationId }, 'station registered')
  }

  /** Undo registerStation (removing a claimed charger); the WS, if still open, reverts to pending. */
  unregisterStation(stationId: string): void {
    this._pendingAutoStart.delete(stationId)
    this._loadpointNames.delete(stationId)
    this.phasesByStation.delete(stationId)
    const s = this.stations.get(stationId)
    if (s) s.autoStartTransaction = false
  }

  setLoadpointName(stationId: string, loadpointName: string): void {
    this._loadpointNames.set(stationId, loadpointName)
  }

  setStationPhases(stationId: string, phases: number): void {
    this.phasesByStation.set(stationId, phases)
  }

  onStatus(stationId: string, cb: StatusCallback): () => void {
    const set = this.subsFor(stationId)
    set.add(cb)
    return () => set.delete(cb)
  }

  /** Persistent per-station subscription set — reused across reconnects. */
  private subsFor(stationId: string): Set<StatusCallback> {
    let set = this.statusSubs.get(stationId)
    if (!set) {
      set = new Set()
      this.statusSubs.set(stationId, set)
    }
    return set
  }

  async setLimit(stationId: string, amps: number): Promise<void> {
    // Remember the commanded limit even if disconnected, so onConnect() can re-assert it.
    this.lastLimitByStation.set(stationId, amps)
    const state = this.stations.get(stationId)
    if (!state) return // Not connected — re-asserted on reconnect via onConnect()
    // Target the active connector, at the charger's max stack level so our profile outranks
    // any leftover/default profile (Zaptec stacks profiles; highest stackLevel wins).
    const stackLevel = this.maxStackByStation.get(stationId) ?? 1
    const numberPhases = this.phasesByStation.get(stationId) ?? 3
    const res = await setCurrentLimit(
      state.client,
      amps,
      state.connectorId,
      stackLevel,
      numberPhases,
    )
    this.log.info(
      { stationId, amps, connectorId: state.connectorId, stackLevel, status: res?.status },
      'SetChargingProfile result',
    )
  }

  getHealth(): ModuleHealth {
    // Health is about the REGISTERED (claimed) chargers only — an unclaimed connection awaiting a
    // claim must not inflate the connected count and mask a degraded state.
    const connectedRegistered = [...this.stations.keys()].filter((id) =>
      this._pendingAutoStart.has(id),
    ).length
    return computeHealth(this._pendingAutoStart.size, connectedRegistered)
  }

  /** Stations connected over OCPP but not registered from config — awaiting a claim. */
  listPending(): PendingStation[] {
    const out: PendingStation[] = []
    for (const stationId of this.stations.keys()) {
      if (this._pendingAutoStart.has(stationId)) continue
      const info = this.pendingInfo.get(stationId)
      out.push({
        stationId,
        vendor: info?.vendor,
        model: info?.model,
        status: info?.lastStatus,
        connectedAt: (info?.firstSeenAt ?? new Date()).toISOString(),
      })
    }
    return out
  }

  async remoteStart(stationId: string, idTag = 'osc-manual'): Promise<void> {
    const state = this.stations.get(stationId)
    if (!state) throw new Error(`station ${stationId} not connected`)
    await remoteStart(state.client, idTag, state.connectorId)
  }

  async remoteStop(stationId: string): Promise<void> {
    const state = this.stations.get(stationId)
    if (!state) throw new Error(`station ${stationId} not connected`)
    if (!state.activeTransactionId) throw new Error(`no active transaction on ${stationId}`)
    await cmdRemoteStop(state.client, state.activeTransactionId)
  }

  async reset(stationId: string, type: 'Soft' | 'Hard' = 'Soft'): Promise<void> {
    const state = this.stations.get(stationId)
    if (!state) throw new Error(`station ${stationId} not connected`)
    const res = await cmdReset(state.client, type)
    this.log.info({ stationId, type, status: res?.status }, 'Reset result')
  }

  async clearChargingProfile(stationId: string): Promise<{ status?: string }> {
    const state = this.stations.get(stationId)
    if (!state) throw new Error(`station ${stationId} not connected`)
    const res = await cmdClearChargingProfile(state.client)
    this.log.info({ stationId, status: res?.status }, 'ClearChargingProfile result')
    return res
  }

  async getCompositeSchedule(stationId: string, durationSec = 60): Promise<CompositeScheduleResp> {
    const state = this.stations.get(stationId)
    if (!state) throw new Error(`station ${stationId} not connected`)
    const res = await cmdGetCompositeSchedule(state.client, state.connectorId, durationSec)
    const limit = res.chargingSchedule?.chargingSchedulePeriod?.[0]?.limit
    this.log.info(
      { stationId, connectorId: state.connectorId, status: res?.status, offeredLimitA: limit },
      'GetCompositeSchedule result',
    )
    return res
  }

  async close(): Promise<void> {
    await this.rpcServer.close({ awaitPending: false, force: true })
  }

  private pushStatus(stationId: string, status: ChargerStatus): void {
    // Read the PERSISTENT subscription set, not the live station's. The disconnect handler
    // evicts the station *before* pushing its final `connected: false`, and subscribers (the
    // loadpoint state + the health map) must still receive it — otherwise a dropped charger
    // is reported `connected: true` forever. While connected the two are the same Set object.
    const subs = this.statusSubs.get(stationId)
    if (!subs) return
    for (const cb of subs) {
      try {
        cb(status)
      } catch {
        /* ignore subscriber errors */
      }
    }
  }

  /**
   * Runs on every socket (re)connect. All best-effort — a flaky reconnect must never throw:
   * mark Operative, discover ChargeProfileMaxStackLevel, re-assert the last commanded limit at
   * that stack level, and ask for a fresh StatusNotification (chargers don't re-send Boot/Status
   * on a bare WS reconnect, so connection state would otherwise go stale).
   */
  private async onConnect(stationId: string, state: StationState): Promise<void> {
    try {
      const res = await changeAvailability(state.client, 0, 'Operative')
      this.log.info({ stationId, status: res?.status }, 'ChangeAvailability(Operative) result')
    } catch (err) {
      this.log.warn({ err, stationId }, 'ChangeAvailability failed')
    }
    try {
      const cfg = await cmdGetConfiguration(state.client, ['ChargeProfileMaxStackLevel'])
      const raw = cfg.configurationKey?.find((k) => k.key === 'ChargeProfileMaxStackLevel')?.value
      const max = raw != null ? parseInt(raw, 10) : NaN
      if (!Number.isNaN(max)) this.maxStackByStation.set(stationId, max)
    } catch (err) {
      this.log.debug({ err, stationId }, 'GetConfiguration failed')
    }
    const last = this.lastLimitByStation.get(stationId)
    if (last !== undefined) {
      await this.setLimit(stationId, last).catch((err) =>
        this.log.warn({ err, stationId }, 're-assert limit on connect failed'),
      )
    }
    try {
      await cmdTriggerMessage(state.client, 'StatusNotification', state.connectorId)
    } catch {
      // TriggerMessage unsupported — at least mark connected so the loadpoint isn't stale-offline.
      this.pushStatus(stationId, {
        connectorId: state.connectorId,
        status: 'Available',
        connected: true,
        charging: false,
      })
    }
  }

  private async attachClient(client: OcppClient): Promise<void> {
    const stationId = client.handshake.identity

    this.log.info({ stationId }, 'OCPP station connected')

    // Unregistered (unclaimed) stations default to autoStartTransaction=false — never auto-start a
    // transaction on a charger OSC doesn't manage yet. Registered stations use their configured value.
    const autoStartTransaction = this._pendingAutoStart.get(stationId) ?? false
    this.pendingInfo.set(stationId, { firstSeenAt: new Date() })
    const state: StationState = {
      client,
      connectorId: 1,
      statusCallbacks: this.subsFor(stationId), // persistent set — survives reconnects
      autoStartTransaction,
      // Rehydrate any in-progress transaction from SQLite: on an OSC restart or a bare WS
      // reconnect the charger does NOT re-send StartTransaction, so without this the in-memory id
      // is lost (remoteStop breaks, meter values get dropped). MeterValues below re-adopt the
      // charger's own transactionId if it ever disagrees (e.g. a stale open row).
      activeTransactionId: findOpenTransaction(this.db, stationId),
    }
    this.stations.set(stationId, state)

    client.on('disconnect', () => {
      this.log.info({ stationId }, 'OCPP station disconnected')
      const s = this.stations.get(stationId)
      // Only evict if THIS client is still the registered one. On a reconnect bounce the
      // charger opens a new socket (which re-registers) before the old socket's disconnect
      // fires; without this guard the stale disconnect would delete the live registration,
      // leaving commands failing "not connected" while messages still flow on the new socket.
      if (s && s.client === client) {
        this.stations.delete(stationId)
        this.pendingInfo.delete(stationId)
        this.pushStatus(stationId, {
          connectorId: s.connectorId,
          status: 'Unavailable',
          connected: false,
          charging: false,
        })
      }
    })

    // Opt-in raw OCPP frame logging (set OCPP_TRACE=1) — invaluable for charger bring-up/debug.
    if (process.env.OCPP_TRACE) {
      client.on('message', (ev: unknown) => {
        const { message, outbound } = ev as { message: string; outbound: boolean }
        this.log.debug({ stationId, dir: outbound ? 'OUT' : 'IN', frame: message }, 'ocpp-frame')
      })
    }

    // On every (re)connect: mark Operative, discover the max stack level, re-assert the last
    // commanded limit, and refresh status — so a charger that dropped (flaky WiFi / host sleep)
    // returns with the correct limit and a fresh status without needing a power cycle.
    setImmediate(() => void this.onConnect(stationId, state))

    // ── Inbound handlers ──────────────────────────────────────────────────

    client.handle('BootNotification', async ({ params }) => {
      const p = params as BootNotificationReq
      this.log.info(
        { stationId, vendor: p.chargePointVendor, model: p.chargePointModel },
        'BootNotification',
      )
      const pinfo = this.pendingInfo.get(stationId)
      if (pinfo) {
        pinfo.vendor = p.chargePointVendor
        pinfo.model = p.chargePointModel
      }

      // Issue safe default current immediately so charger is never at an unknown limit
      setImmediate(() => {
        void setCurrentLimit(
          state.client,
          this.defaultBootCurrentA,
          state.connectorId,
          this.maxStackByStation.get(stationId) ?? 1,
          this.phasesByStation.get(stationId) ?? 3,
        )
          .then((res) =>
            this.log.info(
              {
                stationId,
                amps: this.defaultBootCurrentA,
                connectorId: state.connectorId,
                status: res?.status,
              },
              'boot default SetChargingProfile result',
            ),
          )
          .catch((err) => this.log.warn({ err, stationId }, 'could not set boot default current'))
      })

      return { status: 'Accepted', interval: 60, currentTime: new Date().toISOString() }
    })

    client.handle('Heartbeat', async () => ({
      currentTime: new Date().toISOString(),
    }))

    client.handle('Authorize', async ({ params }) => {
      const p = params as { idTag: string }
      this.log.debug({ stationId, idTag: p.idTag }, 'Authorize accepted')
      return { idTagInfo: { status: 'Accepted' } }
    })

    client.handle('StatusNotification', async ({ params }) => {
      const p = params as StatusNotificationReq

      if (p.connectorId > 0) {
        state.connectorId = p.connectorId
      }

      this.log.debug(
        { stationId, connectorId: p.connectorId, status: p.status },
        'StatusNotification',
      )

      const pinfo = this.pendingInfo.get(stationId)
      if (pinfo) pinfo.lastStatus = p.status

      const { charging, connected } = computeConnectionState(p.status)

      this.pushStatus(stationId, {
        connectorId: p.connectorId,
        status: p.status as ChargerStatus['status'],
        connected,
        charging,
      })

      // Auto-start: send RemoteStartTransaction when vehicle plugs in and no tx is active
      if (
        shouldAutoStartTransaction(
          p.status,
          !!state.activeTransactionId,
          state.autoStartTransaction,
        )
      ) {
        this.log.info({ stationId }, 'auto-starting transaction')
        setImmediate(() => {
          void remoteStart(state.client, 'osc-auto', p.connectorId).catch((err) =>
            this.log.warn({ err, stationId }, 'RemoteStartTransaction failed'),
          )
        })
      }

      return {}
    })

    client.handle('MeterValues', async ({ params }) => {
      const p = params as MeterValuesReq
      // The charger names the transaction these samples belong to — trust it as the authority.
      // This keeps live current/energy attributed across an OSC restart or bare WS reconnect
      // (when the in-memory id was lost, since StartTransaction isn't re-sent on reconnect).
      if (p.transactionId != null) state.activeTransactionId = p.transactionId
      insertMeterValues(this.db, state.activeTransactionId, p)

      if (state.activeTransactionId) {
        const energyKwh = latestEnergyKwh(this.db, state.activeTransactionId)
        const { currentA, powerW } = latestReadings(p)
        this.pushStatus(stationId, {
          connectorId: p.connectorId,
          status: 'Charging',
          connected: true,
          charging: true,
          currentA,
          powerW,
          sessionEnergyKWh: energyKwh,
        })
      }

      return {}
    })

    client.handle('StartTransaction', async ({ params }) => {
      const p = params as StartTransactionReq
      const transactionId = allocateTransactionId(this.db)
      const loadpointName = this._loadpointNames.get(stationId) ?? stationId
      insertTransaction(this.db, loadpointName, stationId, transactionId, p)
      state.activeTransactionId = transactionId

      this.log.info({ stationId, transactionId, idTag: p.idTag }, 'transaction started')

      this.pushStatus(stationId, {
        connectorId: p.connectorId,
        status: 'Charging',
        connected: true,
        charging: true,
        sessionEnergyKWh: 0,
      })

      return { transactionId, idTagInfo: { status: 'Accepted' } }
    })

    client.handle('StopTransaction', async ({ params }) => {
      const p = params as StopTransactionReq
      this.log.info({ stationId, transactionId: p.transactionId }, 'transaction stopped')

      finishTransaction(this.db, p.transactionId, p)
      state.activeTransactionId = undefined

      this.pushStatus(stationId, {
        connectorId: state.connectorId,
        status: 'Finishing',
        connected: true,
        charging: false,
        sessionEnergyKWh: 0,
      })

      return { idTagInfo: { status: 'Accepted' } }
    })

    client.handle('DataTransfer', async () => {
      this.log.debug({ stationId }, 'DataTransfer rejected')
      throw createRPCError('UnknownVendorId')
    })

    // Catch-all for unimplemented messages
    client.handle(async ({ method }: { method?: string }) => {
      this.log.debug({ stationId, method }, 'unhandled OCPP message')
      throw createRPCError('NotImplemented', `${method ?? 'unknown'} is not implemented`)
    })
  }
}
