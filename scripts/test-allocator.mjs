// Standalone allocator smoke-tests (no test framework needed — runs with node)
// Usage: node scripts/test-allocator.mjs

import { allocate } from '../dist/modules/balancer-mqtt-circuit/allocator.js'

let passed = 0
let failed = 0

function assert(label, condition, got) {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}  (got: ${JSON.stringify(got)})`)
    failed++
  }
}

const base = {
  mainBreakerA: 25,
  safeStaticCurrentA: 10,
  phaseCurrentsA: { i1: 5, i2: 5, i3: 5 },
  meterStale: false,
}

function lp(id, mode, currentA = 0, maxCurrentA = 16, shouldChargeNow) {
  return {
    id, mode, currentA, maxCurrentA, shouldChargeNow,
    connected: true, charging: mode !== 'disabled',
    sessionEnergyKWh: 0, pricesAvailable: true,
  }
}

console.log('\nAllocator unit tests\n')

// ─── Case 1: Two smart loadpoints, equal split ───────────────────────────────
{
  const result = allocate({
    ...base,
    loadpoints: [lp('a', 'smart', 0), lp('b', 'smart', 0)],
  })
  // freeAmps = 25 - max(5,5,5) + (0+0) = 20; split = 10 each
  assert('equal split: a gets 10', result.get('a') === 10, result.get('a'))
  assert('equal split: b gets 10', result.get('b') === 10, result.get('b'))
}

// ─── Case 2: fast gets priority, smart gets remainder ────────────────────────
{
  const result = allocate({
    ...base,
    loadpoints: [lp('fast1', 'fast', 0, 16), lp('smart1', 'smart', 0, 16)],
  })
  // freeAmps = 20; fast gets min(16,20)=16; smart gets 20-16=4 (< 6A min → 0)
  assert('fast priority: fast1 gets 16', result.get('fast1') === 16, result.get('fast1'))
  assert('fast priority: smart1 gets 0 (< 6A)', result.get('smart1') === 0, result.get('smart1'))
}

// ─── Case 3: disabled gets 0, smart gets full headroom ───────────────────────
{
  const result = allocate({
    ...base,
    loadpoints: [lp('off', 'disabled', 0), lp('on', 'smart', 0)],
  })
  assert('disabled gets 0', result.get('off') === 0, result.get('off'))
  assert('smart gets 16 (capped by maxCurrentA)', result.get('on') === 16, result.get('on'))
}

// ─── Case 4: smart with shouldChargeNow=false → treated as disabled ──────────
{
  const result = allocate({
    ...base,
    loadpoints: [lp('cheap', 'smart', 0, 16, true), lp('expensive', 'smart', 0, 16, false)],
  })
  // freeAmps=20; only 'cheap' wants current
  assert('shouldChargeNow=false: expensive gets 0', result.get('expensive') === 0, result.get('expensive'))
  assert('shouldChargeNow=true: cheap gets 16 (capped by maxCurrentA)', result.get('cheap') === 16, result.get('cheap'))
}

// ─── Case 5: meter stale → safeStaticCurrentA per wanting loadpoint ──────────
{
  const result = allocate({
    ...base,
    meterStale: true,
    loadpoints: [lp('a', 'smart', 0), lp('b', 'fast', 0)],
  })
  assert('stale: a gets 10', result.get('a') === 10, result.get('a'))
  assert('stale: b gets 10', result.get('b') === 10, result.get('b'))
}

// ─── Case 6: credit-back — chargers already drawing, counts against freeAmps ─
{
  const result = allocate({
    ...base,
    phaseCurrentsA: { i1: 20, i2: 20, i3: 20 }, // house at 20 A, charger included
    loadpoints: [lp('car', 'smart', 5, 16)], // charger currently drawing 5 A
  })
  // freeAmps = 25 - 20 + 5 = 10
  assert('credit-back: car gets 10', result.get('car') === 10, result.get('car'))
}

// ─── Case 7: maxCurrentA cap respected ────────────────────────────────────────
{
  const result = allocate({
    ...base,
    phaseCurrentsA: { i1: 0, i2: 0, i3: 0 },
    loadpoints: [lp('limited', 'smart', 0, 8)], // cap at 8 A
  })
  // freeAmps = 25; should be capped at maxCurrentA=8
  assert('maxCurrentA cap: limited gets 8', result.get('limited') === 8, result.get('limited'))
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
