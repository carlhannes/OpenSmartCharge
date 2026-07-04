// Integration tests: a mock OCPP charger connects to a real OcppServer over a WebSocket and
// we assert the server behaves correctly. Reproduces the behaviors we hit bringing up a real
// Zaptec Go (stacked charging profiles, reconnect bounce, live current/energy). First test in
// the repo to open a real DB + WebSocket.

import { test, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import pino from 'pino'
import { OcppServer } from './server.js'
import { openDb } from '../../core/db.js'
import { createMockCharger, type MockCharger } from './mock-charger.js'
import type { ChargerStatus } from '../../sdk/charger.js'

const log = pino({ level: 'silent' })

interface Harness {
  ocpp: OcppServer
  port: number
  db: DatabaseSync
  cleanup: () => Promise<void>
}

async function bootServer(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'osc-itest-'))
  const db = openDb(dataDir)
  const ocpp = new OcppServer(db, log, 6)
  const http: Server = createServer()
  http.on('upgrade', ocpp.handleUpgrade)
  await new Promise<void>((resolve) => http.listen(0, resolve))
  const port = (http.address() as AddressInfo).port
  const cleanup = async () => {
    await ocpp.close().catch(() => {})
    await new Promise<void>((r) => http.close(() => r()))
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
  return { ocpp, port, db, cleanup }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000, stepMs = 20): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/** Boot server, register + connect a mock charger, capture pushed statuses. */
async function connectCharger(
  h: Harness,
  stationId: string,
  opts: Parameters<typeof createMockCharger>[2] = {},
  autoStart = false,
): Promise<{ charger: MockCharger; statuses: ChargerStatus[] }> {
  const statuses: ChargerStatus[] = []
  h.ocpp.registerStation(stationId, autoStart)
  h.ocpp.onStatus(stationId, (s) => statuses.push(s))
  const charger = createMockCharger(stationId, `ws://localhost:${h.port}/ocpp`, opts)
  await charger.connect()
  return { charger, statuses }
}

test('mock charger connects, boots, and StatusNotification flows to onStatus', async () => {
  const h = await bootServer()
  try {
    const { charger, statuses } = await connectCharger(h, 'MOCK01')
    await charger.boot()
    await charger.statusNotification('Preparing')
    await waitFor(() => statuses.some((s) => s.status === 'Preparing'))
    const last = statuses.at(-1)!
    expect(last.connected).toBe(true)
    expect(last.status).toBe('Preparing')
    await charger.close()
  } finally {
    await h.cleanup()
  }
})

// T6 — A clean disconnect must push `connected: false`. Regression: the disconnect handler
// evicts the station before pushing its final status, and pushStatus used to read the callback
// set off the (now-deleted) station and bail — so a dropped charger was reported connected:true
// forever (commands failed "not connected" while the UI still showed it online).
test('T6: a clean disconnect reports connected:false to onStatus', async () => {
  const h = await bootServer()
  try {
    const { charger, statuses } = await connectCharger(h, 'DROP01')
    await charger.boot()
    await charger.statusNotification('Preparing')
    await waitFor(() => statuses.some((s) => s.connected === true))
    await charger.close() // socket drops (e.g. WiFi switch)
    // A `connected: false` MUST be delivered on disconnect (the bug: it was swallowed because
    // pushStatus read the just-deleted station). Assert delivery, not "last" — the mock's
    // RPCClient auto-reconnects, which would push `connected: true` again afterwards.
    await waitFor(() => statuses.some((s) => s.connected === false))
    const off = statuses.find((s) => s.connected === false)!
    expect(off.charging).toBe(false)
  } finally {
    await h.cleanup()
  }
})

// T1 — Stacked-profile override. A leftover 0 A profile at a HIGH stack level (as evcc's "Off"
// leaves behind) must not defeat OSC. OSC must install at the charger's max stack level so its
// limit wins. Fails until C1 (GetConfiguration-driven stack level).
test('T1: OSC wins over a leftover high-stack 0A profile (composite = commanded)', async () => {
  const h = await bootServer()
  try {
    const { charger } = await connectCharger(h, 'STACK01', {
      maxStackLevel: 8,
      seedProfiles: [
        { connectorId: 0, stackLevel: 8, purpose: 'TxDefaultProfile', chargingProfileId: 99, limit: 0 },
      ],
    })
    await charger.boot()
    await charger.statusNotification('Preparing')
    // Wait until OSC has discovered the max stack level (via on-connect GetConfiguration),
    // so the commanded profile is installed at the top of the stack.
    await waitFor(() => charger.countReceived('GetConfiguration') > 0)
    const before = charger.countReceived('SetChargingProfile')
    await h.ocpp.setLimit('STACK01', 10)
    await waitFor(() => charger.countReceived('SetChargingProfile') > before)
    const res = await h.ocpp.getCompositeSchedule('STACK01')
    const offered = res.chargingSchedule?.chargingSchedulePeriod?.[0]?.limit
    expect(offered).toBe(10) // pre-fix: 0 (stack-8 leftover wins over OSC's stack-1)
    await charger.close()
  } finally {
    await h.cleanup()
  }
})

// T2 — Reconnect bounce must not evict the live station. Locks in yesterday's disconnect guard
// (`s.client === client`). Should already pass.
test('T2: a reconnect bounce keeps the station commandable', async () => {
  const h = await bootServer()
  try {
    h.ocpp.registerStation('BOUNCE01', false)
    const a = createMockCharger('BOUNCE01', `ws://localhost:${h.port}/ocpp`)
    await a.connect()
    await a.boot()
    // New socket, same identity, connects before the old one's disconnect is processed.
    const b = createMockCharger('BOUNCE01', `ws://localhost:${h.port}/ocpp`)
    await b.connect()
    await a.close() // old socket drops — must NOT evict the (newer) registered client
    const before = b.countReceived('SetChargingProfile')
    await h.ocpp.setLimit('BOUNCE01', 12)
    await waitFor(() => b.countReceived('SetChargingProfile') > before)
    expect(b.countReceived('SetChargingProfile')).toBeGreaterThan(before)
    await b.close()
  } finally {
    await h.cleanup()
  }
})

// T3 — On reconnect, OSC must re-assert the last limit and refresh status (TriggerMessage),
// because the charger doesn't re-send Boot/Status on a bare reconnect. Fails until the fix.
test('T3: OSC re-asserts limit + refreshes status on reconnect', async () => {
  const h = await bootServer()
  try {
    const { charger } = await connectCharger(h, 'RECON01')
    await charger.boot()
    await h.ocpp.setLimit('RECON01', 9)
    await waitFor(() => charger.countReceived('SetChargingProfile') > 0)
    await charger.close()
    // Reconnect with a fresh socket (same identity).
    const c2 = createMockCharger('RECON01', `ws://localhost:${h.port}/ocpp`)
    await c2.connect()
    await waitFor(
      () => c2.countReceived('SetChargingProfile') > 0 && c2.countReceived('TriggerMessage') > 0,
    )
    // OSC re-sent the last commanded limit (9 A) at reconnect, without a new BootNotification.
    const lastProfile = [...c2.received].reverse().find((r) => r.method === 'SetChargingProfile')
    const limit = (
      lastProfile?.params as {
        csChargingProfiles?: { chargingSchedule?: { chargingSchedulePeriod?: Array<{ limit?: number }> } }
      }
    )?.csChargingProfiles?.chargingSchedule?.chargingSchedulePeriod?.[0]?.limit
    expect(limit).toBe(9)
    await c2.close()
  } finally {
    await h.cleanup()
  }
})

// T4 — Live current must reach the loadpoint. MeterValues carry Current.Import; OSC must push
// it as ChargerStatus.currentA. Fails until the display fix.
test('T4: MeterValues current is reflected as ChargerStatus.currentA', async () => {
  const h = await bootServer()
  try {
    const { charger, statuses } = await connectCharger(h, 'CUR01')
    await charger.boot()
    await charger.statusNotification('Preparing')
    await charger.startTransaction('mock', 0)
    await charger.meterValues({ currentA: 7.5, powerW: 5175, energyWh: 1000 })
    await waitFor(() => statuses.some((s) => s.currentA !== undefined))
    const withCurrent = statuses.filter((s) => s.currentA !== undefined).at(-1)!
    expect(withCurrent.currentA).toBeCloseTo(7.5, 1)
    await charger.close()
  } finally {
    await h.cleanup()
  }
})

// T5 — Session energy must be the delta from meterStart, not the charger's lifetime register.
// Fails until the energy fix (meter_start column + subtraction).
test('T5: session energy is (latest register − meterStart), not the lifetime register', async () => {
  const h = await bootServer()
  try {
    const { charger, statuses } = await connectCharger(h, 'ENE01')
    await charger.boot()
    await charger.statusNotification('Preparing')
    await charger.startTransaction('mock', 12_147_287) // meterStart Wh
    await charger.meterValues({ energyWh: 12_150_000, currentA: 8, powerW: 5520 })
    await waitFor(() => statuses.some((s) => (s.sessionEnergyKWh ?? 0) > 0))
    const e = statuses.filter((s) => (s.sessionEnergyKWh ?? 0) > 0).at(-1)!.sessionEnergyKWh!
    expect(e).toBeCloseTo(2.713, 2) // (12_150_000 − 12_147_287)/1000
    await charger.close()
  } finally {
    await h.cleanup()
  }
})
