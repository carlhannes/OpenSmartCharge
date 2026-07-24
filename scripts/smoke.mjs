#!/usr/bin/env node
/**
 * OSC integration smoke test.
 *
 * Prerequisites:
 *   1. docker compose up -d mosquitto   (MQTT broker on localhost:1883)
 *   2. npm run build                    (dist/ must be present)
 *
 * Run: npm run smoke
 *
 * Exits 0 if all assertions pass, 1 on any failure.
 */

import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import mqtt from 'mqtt'
import { createFakeCharger } from './lib/fake-charger.mjs'

const SMOKE_DATA_DIR = resolve('./data/smoke-run')
const SMOKE_CONFIG = resolve('./data/smoke.osc.yaml')
const PORT = 8089           // separate port so it doesn't clash with a running dev server
const STATION_ID = 'smoke-01'
const LOADPOINT = 'smoke-loadpoint'
const TOPIC_PREFIX = 'osc-smoke'
const BASE_URL = `http://localhost:${PORT}`
const OCPP_URL = `ws://localhost:${PORT}/ocpp`

// ─── helpers ─────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(label, condition, got) {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}${got !== undefined ? `  (got: ${JSON.stringify(got)})` : ''}`)
    failed++
  }
}

async function waitFor(fn, timeoutMs = 4000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null)
    if (v) return v
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return null
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`)
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function post(path, data) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// ─── smoke config (written fresh each run) ───────────────────────────────────

mkdirSync(SMOKE_DATA_DIR, { recursive: true })
writeFileSync(SMOKE_CONFIG, [
  `site:`,
  `  name: "Smoke Test"`,
  `  port: ${PORT}`,
  ``,
  `mqtt:`,
  `  host: localhost`,
  `  port: 1883`,
  `  topicPrefix: ${TOPIC_PREFIX}`,
  `  homeAssistantDiscovery: false`,
  ``,
  `tariffs: []`,
  `meterReaders: []`,
  `vehicles: []`,
  `balancers: []`,
  ``,
  `chargers:`,
  `  - name: smoke-charger`,
  `    type: ocpp16`,
  `    stationId: ${STATION_ID}`,
  `    maxA: 16`,
  ``,
  `loadpoints:`,
  `  - name: ${LOADPOINT}`,
  `    charger: smoke-charger`,
  `    defaultMode: smart`,
].join('\n'))

if (!existsSync('./dist/core/lifecycle.js')) {
  console.error('Error: dist/core/lifecycle.js not found. Run: npm run build')
  process.exit(1)
}

// ─── main ─────────────────────────────────────────────────────────────────────

let oscProcess = null
let mqttClient = null
let charger = null

async function run() {
  console.log('\nOSC integration smoke test\n')

  // Start OSC
  const oscLogs = []
  oscProcess = spawn('node', ['dist/core/lifecycle.js'], {
    env: {
      ...process.env,
      OSC_CONFIG: SMOKE_CONFIG,
      OSC_DATA_DIR: SMOKE_DATA_DIR,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  oscProcess.stdout.on('data', d => oscLogs.push(d.toString()))
  oscProcess.stderr.on('data', d => oscLogs.push(d.toString()))
  oscProcess.on('exit', (code) => {
    if (code !== null && code !== 0 && code !== null) {
      console.error(`\nOSC exited unexpectedly (code ${code})`)
    }
  })

  const started = await waitFor(async () => {
    return oscLogs.join('').includes('HTTP server listening') ? true : null
  }, 10_000)

  if (!started) {
    console.error('FATAL: OSC did not start within 10s. OSC output:')
    console.error(oscLogs.join(''))
    process.exit(1)
  }
  await new Promise(r => setTimeout(r, 400))

  // Subscribe to MQTT
  const mqttMessages = new Map()
  mqttClient = mqtt.connect('mqtt://localhost:1883', { connectTimeout: 5000 })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('MQTT connect timeout')), 6000)
    mqttClient.on('connect', () => {
      mqttClient.subscribe(`${TOPIC_PREFIX}/#`, (err) => {
        clearTimeout(timeout)
        err ? reject(err) : resolve()
      })
    })
    mqttClient.on('error', (err) => {
      clearTimeout(timeout)
      if (err.code === 'ECONNREFUSED') {
        reject(new Error('MQTT broker not reachable on localhost:1883.\nRun: docker compose up -d mosquitto'))
      } else {
        reject(err)
      }
    })
  })
  mqttClient.on('message', (topic, payload) => mqttMessages.set(topic, payload.toString()))

  // Connect fake charger
  charger = createFakeCharger(STATION_ID, OCPP_URL)
  charger.handle('SetChargingProfile', async () => ({ status: 'Accepted' }))
  charger.handle('RemoteStartTransaction', async () => ({ status: 'Accepted' }))
  charger.handle('RemoteStopTransaction', async () => ({ status: 'Accepted' }))
  charger.handle('Reset', async () => ({ status: 'Accepted' }))

  await charger.connect()
  await charger.boot()
  await charger.heartbeat()
  await charger.statusNotification('Available')

  // Wait for OCPP boot to propagate
  await new Promise(r => setTimeout(r, 500))

  // ── Assertion 1: /api/health responds ───────────────────────────────────────
  const health = await get('/api/health')
  assert('/api/health → 200', health.status === 200, health.status)

  // ── Assertion 2: loadpoint is known to the server ────────────────────────────
  const lps = await get('/api/loadpoints')
  const lp = lps.body?.find(l => l.name === LOADPOINT)
  assert(`loadpoint "${LOADPOINT}" present`, !!lp, lp)

  // ── Assertion 3: MQTT state topic published after boot ───────────────────────
  const stateTopic = `${TOPIC_PREFIX}/loadpoints/${LOADPOINT}/state`
  const hasState = await waitFor(async () => mqttMessages.has(stateTopic) ? true : null, 3000)
  assert(`MQTT ${stateTopic} received`, !!hasState, null)

  // ── Assertion 4: mode change propagates to MQTT ──────────────────────────────
  const modeChange = await post(`/api/loadpoints/${LOADPOINT}/mode`, { mode: 'fast' })
  assert('POST /mode → 200', modeChange.status === 200, modeChange.status)

  const modeTopic = `${TOPIC_PREFIX}/loadpoints/${LOADPOINT}/mode`
  const hasFast = await waitFor(async () => mqttMessages.get(modeTopic) === 'fast' ? true : null, 2000)
  assert(`MQTT mode = "fast"`, !!hasFast, mqttMessages.get(modeTopic))

  // ── Assertion 5: vehicle plug-in (Preparing) sets loadpoint.connected ─────────
  await charger.statusNotification('Preparing')
  const hasConnected = await waitFor(async () => {
    const { body } = await get('/api/loadpoints')
    return body?.some(l => l.name === LOADPOINT && l.connected) ? true : null
  }, 3000)
  assert('loadpoint.connected = true after Preparing', !!hasConnected, null)

  // ── Assertion 6: StartTransaction recorded in DB ─────────────────────────────
  await new Promise(r => setTimeout(r, 200))
  await charger.startTransaction('SMOKE')

  const hasTx = await waitFor(async () => {
    const { body } = await get('/api/transactions?limit=5')
    return body?.some(tx => tx.station_id === STATION_ID) ? true : null
  }, 4000)
  assert('StartTransaction recorded in DB', !!hasTx, null)

  console.log(`\n${passed} passed, ${failed} failed\n`)
}

async function teardown() {
  try { await charger?.close() } catch {}
  await new Promise(r => setTimeout(r, 200))
  try { mqttClient?.end(true) } catch {}
  await new Promise(r => setTimeout(r, 200))
  if (oscProcess && !oscProcess.killed) {
    oscProcess.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 1500))
  }
}

run()
  .catch(err => {
    console.error('\nSmoke test crashed:', err.message ?? err)
    failed++
  })
  .finally(async () => {
    await teardown()
    process.exit(failed > 0 ? 1 : 0)
  })
