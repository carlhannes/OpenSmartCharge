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
import { setCurrentLimit, remoteStart, remoteStop as cmdRemoteStop } from './commands.js'

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
  private readonly _pendingCallbacks = new Map<string, StatusCallback[]>()

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

  onStatus(stationId: string, cb: StatusCallback): () => void {
    const state = this.stations.get(stationId)
    if (state) {
      state.statusCallbacks.add(cb)
      return () => state.statusCallbacks.delete(cb)
    }
    // Station not connected yet — queue the callback
    const list = this._pendingCallbacks.get(stationId) ?? []
    list.push(cb)
    this._pendingCallbacks.set(stationId, list)
    return () => {
      const current = this._pendingCallbacks.get(stationId) ?? []
      this._pendingCallbacks.set(
        stationId,
        current.filter((c) => c !== cb),
      )
    }
  }

  async setLimit(stationId: string, amps: number): Promise<void> {
    const state = this.stations.get(stationId)
    if (!state) return // Not connected — limit will be applied on BootNotification
    await setCurrentLimit(state.client, amps, 0)
  }

  getHealth(): ModuleHealth {
    // Derived from live connection state — no stored field to keep in sync.
    // `stations` mutates on connect/disconnect, so health recomputes for free.
    // Health is server-wide (this OcppServer is shared across all ocpp16 chargers).
    const expected = this._pendingAutoStart.size
    if (expected === 0) return 'ok' // no stations registered — nothing to be unhealthy about
    if (this.stations.size === 0) return 'unavailable'
    return this.stations.size >= expected ? 'ok' : 'degraded'
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

  async close(): Promise<void> {
    await this.rpcServer.close({ awaitPending: false, force: true })
  }

  private pushStatus(stationId: string, status: ChargerStatus): void {
    const state = this.stations.get(stationId)
    if (!state) return
    for (const cb of state.statusCallbacks) {
      try {
        cb(status)
      } catch {
        /* ignore subscriber errors */
      }
    }
  }

  private async attachClient(client: OcppClient): Promise<void> {
    const stationId = client.handshake.identity

    this.log.info({ stationId }, 'OCPP station connected')

    const autoStart = this._pendingAutoStart.get(stationId) ?? true
    const state: StationState = {
      client,
      connectorId: 1,
      statusCallbacks: new Set(this._pendingCallbacks.get(stationId) ?? []),
      autoStart,
    }
    this._pendingCallbacks.delete(stationId)
    this.stations.set(stationId, state)

    client.on('disconnect', () => {
      this.log.info({ stationId }, 'OCPP station disconnected')
      const s = this.stations.get(stationId)
      if (s) {
        this.stations.delete(stationId)
        this.pushStatus(stationId, {
          connectorId: s.connectorId,
          status: 'Unavailable',
          connected: false,
          charging: false,
        })
      }
    })

    // ── Inbound handlers ──────────────────────────────────────────────────

    client.handle('BootNotification', async ({ params }) => {
      const p = params as BootNotificationReq
      this.log.info(
        { stationId, vendor: p.chargePointVendor, model: p.chargePointModel },
        'BootNotification',
      )

      // Issue safe default current immediately so charger is never at an unknown limit
      setImmediate(() => {
        void setCurrentLimit(state.client, this.defaultBootCurrentA, 0).catch((err) =>
          this.log.warn({ err, stationId }, 'could not set boot default current'),
        )
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

      const charging =
        p.status === 'Charging' || p.status === 'SuspendedEV' || p.status === 'SuspendedEVSE'
      const connected =
        p.status !== 'Available' && p.status !== 'Unavailable' && p.status !== 'Faulted'

      this.pushStatus(stationId, {
        connectorId: p.connectorId,
        status: p.status as ChargerStatus['status'],
        connected,
        charging,
      })

      // Auto-start: send RemoteStartTransaction when vehicle plugs in and no tx is active
      if (p.status === 'Preparing' && !state.activeTransactionId && state.autoStart) {
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
        this.pushStatus(stationId, {
          connectorId: p.connectorId,
          status: 'Charging',
          connected: true,
          charging: true,
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
