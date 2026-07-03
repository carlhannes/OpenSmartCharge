import { test, expect } from 'vitest'
import { createDebouncedSetter } from './debounce.js'

/** Synchronous fake scheduler: collects pending callbacks with their delay. */
function makeFakeClock() {
  let now = 0
  const pending: Array<{ fn: () => void; fireAt: number }> = []

  function tick(ms: number) {
    now += ms
    const ready = pending.filter((p) => p.fireAt <= now)
    for (const p of ready) {
      pending.splice(pending.indexOf(p), 1)
      p.fn()
    }
  }

  return {
    now: () => now,
    schedule: (fn: () => void, delay: number) => {
      pending.push({ fn, fireAt: now + delay })
    },
    tick,
  }
}

test('duplicate value (same as last written) is dropped', async () => {
  const writes: number[] = []
  const clock = makeFakeClock()
  const set = createDebouncedSetter({
    minIntervalMs: 10_000,
    now: clock.now,
    schedule: clock.schedule,
    write: async (v) => {
      writes.push(v)
    },
  })

  await set(8) // first write — goes through immediately
  await set(8) // duplicate — dropped
  await set(8) // duplicate — dropped

  expect(writes).toEqual([8])
})

test('two writes within minIntervalMs: one immediate + one coalesced trailing', async () => {
  const writes: number[] = []
  const clock = makeFakeClock()
  const set = createDebouncedSetter({
    minIntervalMs: 10_000,
    now: clock.now,
    schedule: clock.schedule,
    write: async (v) => {
      writes.push(v)
    },
  })

  await set(8) // immediate write at t=0
  await set(12) // suppressed, trailing scheduled at t=0+10000
  clock.tick(10_000)

  expect(writes).toEqual([8, 12])
})

test('trailing write is the last coalesced value', async () => {
  const writes: number[] = []
  const clock = makeFakeClock()
  const set = createDebouncedSetter({
    minIntervalMs: 10_000,
    now: clock.now,
    schedule: clock.schedule,
    write: async (v) => {
      writes.push(v)
    },
  })

  await set(8) // immediate
  await set(10) // suppressed — trailing pending
  await set(12) // overwrites pending value (still one trailing scheduled)
  await set(14) // overwrites pending value again
  clock.tick(10_000)

  expect(writes).toEqual([8, 14])
})

test('trailing write equals last written: no write', async () => {
  const writes: number[] = []
  const clock = makeFakeClock()
  const set = createDebouncedSetter({
    minIntervalMs: 10_000,
    now: clock.now,
    schedule: clock.schedule,
    write: async (v) => {
      writes.push(v)
    },
  })

  await set(8) // immediate
  await set(8) // duplicate — no trailing scheduled (value == lastWritten)
  clock.tick(10_000)

  expect(writes).toEqual([8])
})

test('write after cooldown goes through immediately without trailing', async () => {
  const writes: number[] = []
  const clock = makeFakeClock()
  const set = createDebouncedSetter({
    minIntervalMs: 10_000,
    now: clock.now,
    schedule: clock.schedule,
    write: async (v) => {
      writes.push(v)
    },
  })

  await set(8) // t=0: immediate
  clock.tick(10_000) // t=10_000: cooldown expired
  await set(12) // immediate (cooldown elapsed)

  expect(writes).toEqual([8, 12])
})
