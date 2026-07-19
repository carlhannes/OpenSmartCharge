// Quick mock backend for developing/testing ui2 without the real hardware.
// Zero-dependency node:http server implementing the OpenSmartCharge REST + SSE contract
// with mutable in-memory state and a ticking simulation, so ui2 can be driven end-to-end
// including the write path (mode changes, OCPP commands) that can't be tried on a real car.
//
// Point ui2 at it:  OSC_BACKEND=http://localhost:9099 npm run dev:ui2
// Or run both:      npm run dev:ui2:mock
import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 9099)

// --- mutable in-memory state ---
const lp = {
  name: 'garage',
  mode: 'smart', // disabled | smart | fast
  targetSoc: 80,
  targetTime: undefined,
  targetKWh: undefined,
  connected: true,
  charging: true,
  currentA: 10,
  sessionEnergyKWh: 3.2,
  maxCurrentA: 16,
  minSoc: 20,
}
const veh = { soc: 62, range: 310, batteryCapacity: 77 }
let oneShotCap = null
let lastResolveJson = null // change-guard for the loadpoint.resolve SSE (emit only on decision change)

// Plans (per loadpoint) + site settings.
let plans = [
  {
    id: '1',
    loadpointName: 'garage',
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    readyBy: '07:00',
    target: 80,
    unit: 'pct',
    enabled: true,
  },
]
let nextPlanId = 2
let settings = { timezone: 'Europe/Stockholm' }
let siteBreaker = 25 // site-level main breaker (A) — PUT /api/site
let logRetentionDays = 3 // days of logs kept before rotation — GET/PUT /api/logs/config
let tariffZone = 'SE3' // primary tariff zone — PUT /api/tariffs/:name
let chargerLabel = 'garage' // charger display label — PUT /api/chargers/:name { label }
let houseBaseW = 700 // wandering non-EV house draw (W); meter power = base + EV charging draw

// Vehicles: the type descriptors that drive the create/edit form (GET /api/vehicle-types) + a mutable
// topology list (add/edit/remove via /api/vehicles). Mirrors src/modules/vehicle-*/index.ts so ui2's
// live write path can be exercised here (never on the real backend).
const VEHICLE_TYPES = [
  {
    type: 'skoda',
    label: 'Škoda / VW group (app login)',
    fields: [
      { key: 'username', label: 'App email', required: true },
      { key: 'password', label: 'App password', type: 'password', required: true, secret: true },
      {
        key: 'vin',
        label: 'VIN',
        required: true,
        pattern: '^[A-Za-z0-9]{17}$',
        help: '17 characters, as shown in the MySkoda app.',
      },
    ],
    capabilities: { soc: true, range: true, capacity: true, presence: true, climate: true, targetSoc: true },
  },
  {
    type: 'manual',
    label: 'Manual (no app / other car)',
    fields: [],
    capabilities: { soc: false, range: false, capacity: false, presence: false, climate: false, targetSoc: false },
  },
]
let siteVehicles = [{ name: 'enyaq', type: 'skoda', vin: 'MOCKVIN0000000001' }]

// Whole-house meter reading — base house load + whatever the car is drawing (charger is downstream).
const meterSnapshot = () => {
  const evW = lp.charging ? Math.round(lp.currentA * 230) : 0
  const powerW = Math.max(0, Math.round(houseBaseW)) + evW
  const perPhaseA = +(powerW / 230 / 3).toFixed(1)
  return {
    powerW,
    i1A: perPhaseA,
    i2A: perPhaseA,
    i3A: perPhaseA,
    timestamp: new Date().toISOString(),
  }
}

// Logs (ring buffer) for the /api/logs viewer — seeded across ~a day + appended live below.
const logModules = ['charger', 'vehicle', 'tariff', 'balancer', 'ocpp', 'loadpoint']
const logMsgs = {
  info: [
    'module started',
    'charger connected',
    'tariff prices updated',
    'plan resolved',
    'session finished',
  ],
  debug: ['tick ok', 'poll ok (312ms)', 'cache hit', 'allocation computed'],
  warn: ['vehicle poll slow (2.3s)', 'meter reading stale', 'price fallback used', 'reconnecting'],
  error: ['OCPP reset failed: timeout', 'vehicle auth failed', 'meter unreachable'],
}
const logCycle = ['info', 'info', 'debug', 'info', 'warn', 'info', 'debug', 'warn', 'info', 'error']
const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length]
let logSeq = 1001
let logs = Array.from({ length: 30 }, (_, i) => {
  const level = pick(logCycle, i)
  const module = pick(logModules, i)
  const msg = pick(logMsgs[level], i)
  return {
    id: 1000 - i, // newest = highest id
    time: new Date(Date.now() - i * 47 * 60000).toISOString(), // ~47 min apart → ~1 day span
    level,
    module,
    msg,
    ...(level === 'error'
      ? {
          err: `Error: ${msg}\n    at Module.tick (charger.ts:142)\n    at Loop.run (lifecycle.ts:820)`,
          fields: { attempt: 2, code: 'ETIMEDOUT' },
        }
      : {}),
    ...(level === 'warn' ? { fields: { latencyMs: 2300 } } : {}),
  }
})

// The control loop's per-tick decision — mirrors LoadpointState.resolve. budgetA is the amp cap being
// applied; sources name a plausible ladder rung. shouldChargeNow is a SMART-mode-only decision (like the
// real resolver): present in smart, OMITTED in fast/disabled where `mode` is the "why".
const resolveDto = () => ({
  ...(lp.mode === 'smart'
    ? { shouldChargeNow: lp.connected && (lp.targetSoc == null || veh.soc < lp.targetSoc) }
    : {}),
  budgetA: oneShotCap ?? lp.maxCurrentA,
  sources: { energy: 'soc-capacity', price: 'live-tariff', current: 'live-meter' },
})

const loadpointDto = () => ({
  name: lp.name,
  mode: lp.mode,
  ...(lp.targetSoc != null ? { targetSoc: lp.targetSoc } : {}),
  ...(lp.targetTime != null ? { targetTime: lp.targetTime } : {}),
  ...(lp.targetKWh != null ? { targetKWh: lp.targetKWh } : {}),
  ...(lp.minSoc != null ? { minSoc: lp.minSoc } : {}),
  connected: lp.connected,
  charging: lp.charging,
  currentA: lp.charging ? lp.currentA : 0,
  powerW: lp.charging ? Math.round(lp.currentA * 230) : 0,
  sessionEnergyKWh: +lp.sessionEnergyKWh.toFixed(2),
  maxCurrentA: lp.maxCurrentA,
  availableTargetUnits: [
    ...(veh.soc != null && veh.batteryCapacity != null ? ['pct'] : []),
    ...(veh.range != null ? ['km'] : []),
    'kwh',
  ],
  resolve: resolveDto(),
})

// Backend computes each plan's display SoC%: pct→value, km→via range/soc ratio, kwh/no-car→null.
const resolvedSocFor = (p) => {
  if (p.unit === 'pct') return p.target
  if (p.unit === 'km') {
    if (!veh.soc || !veh.range) return null
    const fullRangeKm = veh.range / (veh.soc / 100)
    return Math.min(100, Math.round((p.target / fullRangeKm) * 100))
  }
  return null // kwh
}
const planDto = (p) => ({ ...p, resolvedSoc: resolvedSocFor(p) })

const txRow = (id) => ({
  id,
  loadpoint_name: 'garage',
  station_id: 'MOCK-1',
  start_time: new Date(Date.now() - id * 86400000 - 3600000).toISOString(),
  end_time: new Date(Date.now() - id * 86400000).toISOString(),
  energy_kwh: 8 + id * 3,
  meter_start: 0,
  id_tag: null,
})

// --- SSE fan-out ---
const clients = new Set()
const emit = (event, data) => {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(frame)
}
const stateFrame = () =>
  emit('loadpoint.state', {
    name: lp.name,
    connected: lp.connected,
    charging: lp.charging,
    currentA: lp.charging ? lp.currentA : 0,
    powerW: lp.charging ? Math.round(lp.currentA * 230) : 0,
    sessionEnergyKWh: +lp.sessionEnergyKWh.toFixed(2),
  })

// Emit loadpoint.resolve only when the decision changes (change-guarded, like the real backend).
const resolveFrame = () => {
  const resolveJson = JSON.stringify(resolveDto())
  if (resolveJson !== lastResolveJson) {
    lastResolveJson = resolveJson
    emit('loadpoint.resolve', { name: lp.name, ...resolveDto() })
  }
}

// Ticking simulation: advance the session while charging and push live SSE.
setInterval(() => {
  if (lp.connected && lp.charging && lp.mode !== 'disabled') {
    const cap = oneShotCap ?? lp.maxCurrentA
    lp.currentA = lp.mode === 'fast' ? lp.maxCurrentA : Math.min(cap, lp.maxCurrentA)
    lp.sessionEnergyKWh += ((lp.currentA * 230) / 1000) * (2 / 3600) // ~2s of energy
    veh.soc = Math.min(100, veh.soc + 0.2)
    veh.range = Math.round(veh.batteryCapacity * (veh.soc / 100) * 6.5)
  } else {
    lp.currentA = 0
  }
  stateFrame()
  resolveFrame()
  emit('vehicle.poll', { name: 'enyaq', soc: Math.round(veh.soc) })
}, 2000)
setInterval(() => {
  for (const res of clients) res.write(': heartbeat\n\n')
}, 30000)

// Module health — mutable so the flap below exercises the live `health.changed` SSE path (Phase 4:
// honest banner + live status). "balancer:house" stays degraded (a peripheral) so the dashboard
// shows the "charging continues" banner by default; "garage" (the charger link) flaps ok↔degraded
// every 10 s + emits `health.changed`, so the honest banner switches to "not charging" and the
// status page updates within ~1 s (via SSE) rather than waiting for the client's 15 s poll.
const health = {
  garage: 'ok',
  tariff: 'ok',
  'balancer:house': 'degraded',
  'vehicle:enyaq': 'ok',
  mqtt: 'ok',
}
setInterval(() => {
  health.garage = health.garage === 'ok' ? 'degraded' : 'ok'
  emit('health.changed', { id: 'garage', health: health.garage })
}, 10000)

// Append a synthetic log line periodically so the viewer's auto-refresh visibly updates.
setInterval(() => {
  const level = pick(['info', 'debug', 'info', 'warn'], logSeq)
  logs.push({
    id: logSeq++,
    time: new Date().toISOString(),
    level,
    module: pick(logModules, logSeq),
    msg: pick(logMsgs[level], logSeq),
  })
  if (logs.length > 500) logs = logs.slice(-500)
}, 10000)

// Push a live household-power reading every ~10s (EVCC-style), like the real meter.snapshot stream.
setInterval(() => {
  houseBaseW = Math.min(2500, Math.max(200, houseBaseW + (Math.random() - 0.5) * 500))
  emit('meter.snapshot', { name: 'pulse', snapshot: meterSnapshot() })
}, 10000)

const send = (res, obj, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(obj))
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type',
    })
    return res.end()
  }

  const p = new URL(req.url, 'http://x').pathname

  if (p === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    })
    res.write(': connected\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  // Settings (site timezone).
  if (p === '/api/settings') {
    if (req.method === 'GET') return send(res, settings)
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const b = JSON.parse(body || '{}')
        if (b.timezone) settings = { timezone: b.timezone }
      } catch {
        /* ignore */
      }
      emit('settings.changed', settings)
      return send(res, settings)
    })
    return
  }

  // Runtime config writes — each mutates state + emits config.changed (ui2 reconciles from /api/site).
  const readBody = (cb) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        cb(JSON.parse(body || '{}'))
      } catch {
        cb({})
      }
    })
  }
  if (p === '/api/site' && req.method === 'PUT') {
    readBody((b) => {
      if (b.mainBreakerA != null) siteBreaker = b.mainBreakerA
      emit('config.changed', { kind: 'site', name: 'site' })
      send(res, { ok: true })
    })
    return
  }
  const tariffPut = p.match(/^\/api\/tariffs\/([^/]+)$/)
  if (tariffPut && req.method === 'PUT') {
    readBody((b) => {
      if (b.zone) tariffZone = b.zone
      emit('config.changed', { kind: 'tariff', name: tariffPut[1] })
      send(res, { ok: true })
    })
    return
  }
  const chargerPut = p.match(/^\/api\/chargers\/([^/]+)$/)
  if (chargerPut && req.method === 'PUT') {
    readBody((b) => {
      if (b.maxA != null) lp.maxCurrentA = b.maxA
      if (b.label != null) chargerLabel = b.label
      emit('config.changed', { kind: 'charger', name: chargerPut[1] })
      send(res, { ok: true })
    })
    return
  }

  // Plans: /api/loadpoints/:name/plans[/:id]
  const planMatch = p.match(/^\/api\/loadpoints\/([^/]+)\/plans(?:\/([^/]+))?$/)
  if (planMatch) {
    const name = planMatch[1]
    const id = planMatch[2]
    if (req.method === 'GET')
      return send(res, plans.filter((pl) => pl.loadpointName === name).map(planDto))
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let b = {}
      try {
        b = body ? JSON.parse(body) : {}
      } catch {
        /* ignore */
      }
      if (req.method === 'POST') {
        const plan = {
          id: String(nextPlanId++),
          loadpointName: name,
          days: b.days,
          readyBy: b.readyBy,
          target: b.target,
          unit: b.unit,
          enabled: b.enabled ?? true,
        }
        plans.push(plan)
        emit('loadpoint.plans', { name })
        return send(res, planDto(plan), 201)
      }
      if (req.method === 'PUT' && id) {
        const plan = plans.find((pl) => pl.id === id && pl.loadpointName === name)
        if (!plan) {
          res.writeHead(404, { 'access-control-allow-origin': '*' })
          return res.end('not found')
        }
        Object.assign(plan, b)
        emit('loadpoint.plans', { name })
        return send(res, planDto(plan))
      }
      if (req.method === 'DELETE' && id) {
        plans = plans.filter((pl) => !(pl.id === id && pl.loadpointName === name))
        emit('loadpoint.plans', { name })
        res.writeHead(204, { 'access-control-allow-origin': '*' })
        return res.end()
      }
      res.writeHead(405, { 'access-control-allow-origin': '*' })
      res.end('method not allowed')
    })
    return
  }

  // Vehicles: type descriptors (GET) + generic add/edit/remove. Mirrors the real generic CRUD, incl.
  // the "blank field = keep" edit semantics. add/edit/remove emit config.changed → ui2 rehydrates.
  if (p === '/api/vehicle-types' && req.method === 'GET') return send(res, VEHICLE_TYPES)
  const vehItem = p.match(/^\/api\/vehicles\/([^/]+)$/)
  if (
    (p === '/api/vehicles' && req.method === 'POST') ||
    (vehItem && (req.method === 'PUT' || req.method === 'DELETE'))
  ) {
    if (req.method === 'DELETE') {
      const name = vehItem[1]
      siteVehicles = siteVehicles.filter((v) => v.name !== name)
      emit('config.changed', { kind: 'vehicle', name })
      res.writeHead(204, { 'access-control-allow-origin': '*' })
      return res.end()
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let b = {}
      try {
        b = body ? JSON.parse(body) : {}
      } catch {
        /* ignore */
      }
      if (req.method === 'POST') {
        const name = String(b.name ?? '').trim()
        const type = String(b.type ?? 'skoda').trim()
        if (!name) return send(res, { error: 'name is required' }, 400)
        if (siteVehicles.some((v) => v.name === name))
          return send(res, { error: `name "${name}" already in use` }, 409)
        const desc = VEHICLE_TYPES.find((t) => t.type === type)
        if (!desc) return send(res, { error: `unknown vehicle type "${type}"` }, 400)
        for (const f of desc.fields) {
          const val = String(b[f.key] ?? '').trim()
          if (!val && f.required) return send(res, { error: `${f.label} is required` }, 400)
          if (val && f.pattern && !new RegExp(f.pattern).test(val))
            return send(res, { error: `${f.label} is invalid` }, 400)
        }
        siteVehicles.push({ name, type, vin: b.vin ? String(b.vin).trim() : undefined })
        emit('config.changed', { kind: 'vehicle', name })
        return send(res, { name, type }, 201)
      }
      // PUT edit — name/type immutable; a blank field keeps the stored value (only vin is visible here).
      const name = vehItem[1]
      const v = siteVehicles.find((x) => x.name === name)
      if (!v) return send(res, { error: 'vehicle not found' }, 404)
      const desc = VEHICLE_TYPES.find((t) => t.type === v.type)
      for (const f of desc?.fields ?? []) {
        const val = String(b[f.key] ?? '').trim()
        if (val && f.pattern && !new RegExp(f.pattern).test(val))
          return send(res, { error: `${f.label} is invalid` }, 400)
        if (val && f.key === 'vin') v.vin = val
      }
      emit('config.changed', { kind: 'vehicle', name })
      return send(res, { name, type: v.type })
    })
    return
  }

  // Writes: mutate state, then push the matching SSE event.
  if (req.method === 'POST' && p.startsWith('/api/loadpoints/')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let b = {}
      try {
        b = body ? JSON.parse(body) : {}
      } catch {
        /* ignore */
      }
      if (p.endsWith('/mode')) {
        lp.mode = b.mode
        if (lp.mode === 'disabled') lp.charging = false
        emit('loadpoint.mode', { name: lp.name, mode: lp.mode })
        return send(res, loadpointDto())
      }
      if (p.endsWith('/target')) {
        // COALESCE-merge — only overwrite fields present in the body.
        if (b.soc !== undefined) lp.targetSoc = b.soc
        if (b.time !== undefined) lp.targetTime = b.time
        if (b.kwh !== undefined) lp.targetKWh = b.kwh
        if (b.minSoc !== undefined) lp.minSoc = b.minSoc
        emit('loadpoint.target', {
          name: lp.name,
          targetSoc: lp.targetSoc,
          targetTime: lp.targetTime,
          targetKWh: lp.targetKWh,
          minSoc: lp.minSoc,
        })
        return send(res, loadpointDto())
      }
      if (p.endsWith('/start')) {
        lp.charging = true
        stateFrame()
        return send(res, loadpointDto())
      }
      if (p.endsWith('/stop')) {
        lp.charging = false
        lp.currentA = 0
        stateFrame()
        return send(res, loadpointDto())
      }
      if (p.endsWith('/reset'))
        return send(res, { ok: true, type: b.type === 'Hard' ? 'Hard' : 'Soft' })
      if (p.endsWith('/clear-profile')) {
        oneShotCap = null
        return send(res, { status: 'Accepted' })
      }
      if (p.endsWith('/profile')) {
        oneShotCap = b.amps
        return send(res, loadpointDto())
      }
      return send(res, loadpointDto())
    })
    return
  }

  if (p.startsWith('/api/loadpoints/') && p.endsWith('/composite-schedule'))
    return send(res, {
      connectorId: 1,
      chargingSchedule: {
        duration: 3600,
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [
          { startPeriod: 0, limit: oneShotCap ?? lp.maxCurrentA },
          { startPeriod: 1800, limit: 6 },
        ],
      },
    })

  if (p === '/api/loadpoints') return send(res, [loadpointDto()])
  if (p === '/api/loadpoints/garage') return send(res, loadpointDto())
  if (p === '/api/health') return send(res, health)
  if (p === '/api/site')
    return send(res, {
      site: {
        name: 'Mock Home',
        port: PORT,
        mainBreakerA: siteBreaker,
        timezone: settings.timezone,
      },
      loadpoints: [
        {
          name: 'garage',
          charger: 'garage',
          tariff: 'home',
          balancer: 'house',
          vehicle: 'enyaq',
          maxCurrentA: lp.maxCurrentA,
        },
      ],
      chargers: [
        {
          name: 'garage',
          label: chargerLabel,
          type: 'ocpp16',
          stationId: 'MOCK-1',
          maxA: lp.maxCurrentA,
        },
      ],
      balancers: [{ name: 'house', type: 'mqtt-circuit', mainBreakerA: siteBreaker, phases: 3 }],
      tariffs: [{ name: 'home', type: 'nordpool', zone: tariffZone }],
      vehicles: siteVehicles,
      meterReaders: [{ name: 'pulse', type: 'tibber-pulse' }],
    })
  if (vehItem && req.method === 'GET') {
    const name = vehItem[1]
    const v = siteVehicles.find((x) => x.name === name)
    if (!v) return send(res, { error: 'not found' }, 404)
    const caps = VEHICLE_TYPES.find((t) => t.type === v.type)?.capabilities
    // enyaq has the live sim; a just-added or manual car has no telemetry yet (data: null).
    if (name === 'enyaq')
      return send(res, {
        name,
        health: 'ok',
        data: {
          soc: Math.round(veh.soc),
          range: veh.range,
          batteryCapacity: veh.batteryCapacity,
          isCharging: lp.charging,
          pluggedIn: lp.connected,
          fetchedAt: new Date().toISOString(),
        },
        capacityKWh: veh.batteryCapacity,
        capabilities: caps,
      })
    return send(res, { name, health: 'ok', data: null, capacityKWh: null, capabilities: caps })
  }
  if (p.startsWith('/api/tariffs/') && p.endsWith('/prices'))
    return send(
      res,
      Array.from({ length: 24 }, (_, h) => ({
        start: new Date(new Date().setHours(h, 0, 0, 0)).toISOString(),
        end: new Date(new Date().setHours(h + 1, 0, 0, 0)).toISOString(),
        pricePerKWh: +(0.6 + 0.5 * Math.sin(h / 3.5)).toFixed(3),
        currency: 'SEK',
      })),
    )
  const meterGet = p.match(/^\/api\/meters\/([^/]+)$/)
  if (meterGet && req.method === 'GET') return send(res, { latest: meterSnapshot(), health: 'ok' })
  if (p === '/api/balancers/house')
    return send(res, {
      name: 'house',
      health: 'ok',
      lastAllocations: { garage: lp.currentA },
      freeAmps: 13,
    })
  if (p === '/api/transactions') return send(res, [txRow(1), txRow(2)])
  if (p.startsWith('/api/transactions/'))
    return send(res, {
      transaction: txRow(Number(p.split('/').pop()) || 1),
      samples: Array.from({ length: 20 }, (_, i) => ({
        measured_at: new Date(Date.now() - 3600000 + i * 180000).toISOString(),
        energy_kwh: +(i * 0.6).toFixed(2),
        power_w: 7000 + i * 60,
        current_a: 30,
        soc: 40 + i * 2,
      })),
    })

  if (p === '/api/logs/config') {
    if (req.method === 'GET') return send(res, { retentionDays: logRetentionDays })
    if (req.method === 'PUT') {
      readBody((b) => {
        const d = Number(b.retentionDays)
        if (!Number.isInteger(d) || d < 1 || d > 365)
          return send(res, { error: 'retentionDays must be an integer 1–365' }, 400)
        logRetentionDays = d
        const cutoff = Date.now() - d * 86400000 // best-effort demo prune, mirrors the backend
        logs = logs.filter((l) => Date.parse(l.time) >= cutoff)
        send(res, { retentionDays: logRetentionDays })
      })
      return
    }
  }

  if (p === '/api/logs/export' && req.method === 'GET') {
    const u = new URL(req.url, 'http://x')
    const order = ['debug', 'info', 'warn', 'error']
    const lvl = u.searchParams.get('level')
    const minRank = lvl ? order.indexOf(lvl) : 0
    const sinceMs = u.searchParams.get('since')
      ? Date.parse(u.searchParams.get('since'))
      : -Infinity
    const untilMs = u.searchParams.get('until') ? Date.parse(u.searchParams.get('until')) : Infinity
    const q = (u.searchParams.get('q') || '').toLowerCase()
    const fmt = (e) => {
      let line = `${e.time} ${e.level.toUpperCase().padEnd(5)}`
      if (e.module) line += ` [${e.module}]`
      line += ` ${e.msg}`
      if (e.fields) line += ` ${JSON.stringify(e.fields)}`
      if (e.err)
        line +=
          '\n' +
          e.err
            .split('\n')
            .map((l) => `    ${l}`)
            .join('\n')
      return line
    }
    const text =
      logs
        .filter((l) => order.indexOf(l.level) >= minRank)
        .filter((l) => {
          const t = Date.parse(l.time)
          return t >= sinceMs && t <= untilMs
        })
        .filter((l) => !q || `${l.module || ''} ${l.msg}`.toLowerCase().includes(q))
        .sort((a, b) => a.id - b.id) // chronological, like a real logfile
        .map(fmt)
        .join('\n') + (logs.length ? '\n' : '')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="osc-logs-${stamp}.log"`,
      'access-control-allow-origin': '*',
    })
    return res.end(text)
  }

  if (p === '/api/logs' && req.method === 'GET') {
    const u = new URL(req.url, 'http://x')
    const order = ['debug', 'info', 'warn', 'error']
    const lvl = u.searchParams.get('level')
    const minRank = lvl ? order.indexOf(lvl) : 0
    const sinceMs = u.searchParams.get('since')
      ? Date.parse(u.searchParams.get('since'))
      : -Infinity
    const untilMs = u.searchParams.get('until') ? Date.parse(u.searchParams.get('until')) : Infinity
    const q = (u.searchParams.get('q') || '').toLowerCase()
    const limit = Math.min(Number(u.searchParams.get('limit') || 200), 500)
    const out = logs
      .filter((l) => order.indexOf(l.level) >= minRank)
      .filter((l) => {
        const t = Date.parse(l.time)
        return t >= sinceMs && t <= untilMs
      })
      .filter((l) => !q || `${l.module || ''} ${l.msg}`.toLowerCase().includes(q))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
    return send(res, out)
  }

  res.writeHead(404, { 'access-control-allow-origin': '*' })
  res.end('not found')
})

server.listen(PORT, () =>
  console.log(`[mock-backend] OpenSmartCharge mock on http://localhost:${PORT}`),
)
