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
import { computeConnectionState, shouldAutoStart, computeHealth } from './status.js'
import { latestReadings } from './meter-parser.js'

type StatusCallback = (status: ChargerStatus) => void

interface StationState {
  client: OcppClient
  activeTransactionId?: number
  connectorId: number
  statusCallbacks: Set<StatusCallback>
  autoStart: boolean
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

  registerStation(stationId: string, autoStart: boolean): void {
    this._pendingAutoStart.set(stationId, autoStart)
    this.log.debug({ stationId }, 'station registered (waiting for connection)')
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
    // Derived from live connection state — no stored field to keep in sync.
    // `stations` mutates on connect/disconnect, so health recomputes for free.
    return computeHealth(this._pendingAutoStart.size, this.stations.size)
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

    const autoStart = this._pendingAutoStart.get(stationId) ?? true
    const state: StationState = {
      client,
      connectorId: 1,
      statusCallbacks: this.subsFor(stationId), // persistent set — survives reconnects
      autoStart,
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

      const { charging, connected } = computeConnectionState(p.status)

      this.pushStatus(stationId, {
        connectorId: p.connectorId,
        status: p.status as ChargerStatus['status'],
        connected,
        charging,
      })

      // Auto-start: send RemoteStartTransaction when vehicle plugs in and no tx is active
      if (shouldAutoStart(p.status, !!state.activeTransactionId, state.autoStart)) {
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
