import { test, expect } from 'vitest'
import { runPostStartup, type PostStartupModule } from './post-startup.js'

const cfg = { baseMs: 100, factor: 2, maxMs: 1000 }
const silent = { warn() {} }
const noDelay = async () => {}

test('runPostStartup calls each hook once and skips modules without one', async () => {
  const calls: string[] = []
  const mods: PostStartupModule[] = [
    { id: 'a', postStartup: async () => void calls.push('a') },
    { id: 'b' }, // no hook → never invoked
    { id: 'c', postStartup: async () => void calls.push('c') },
  ]
  await runPostStartup(mods, { cfg, maxAttempts: 6, delay: noDelay, log: silent })
  expect(calls.sort()).toEqual(['a', 'c'])
})

test('runPostStartup retries only the failing module with backoff, drops successes', async () => {
  const calls: Record<string, number> = {}
  const mk = (id: string, failTimes: number): PostStartupModule => ({
    id,
    postStartup: async () => {
      calls[id] = (calls[id] ?? 0) + 1
      if (calls[id] <= failTimes) throw new Error('boom')
    },
  })
  const delays: number[] = []
  await runPostStartup([mk('ok', 0), mk('flaky', 2)], {
    cfg,
    maxAttempts: 6,
    delay: async (ms) => void delays.push(ms),
    log: silent,
  })
  expect(calls).toEqual({ ok: 1, flaky: 3 }) // ok once; flaky failed twice then succeeded on the 3rd
  expect(delays).toEqual([100, 200]) // 2 gaps between 3 attempts: base, base×factor (capped exp backoff)
})

test('runPostStartup gives up after maxAttempts', async () => {
  let n = 0
  const delays: number[] = []
  const always: PostStartupModule = {
    id: 'always',
    postStartup: async () => {
      n++
      throw new Error('boom')
    },
  }
  await runPostStartup([always], {
    cfg,
    maxAttempts: 3,
    delay: async (ms) => void delays.push(ms),
    log: silent,
  })
  expect(n).toBe(3) // attempts 1,2,3, then stops
  expect(delays).toEqual([100, 200]) // no delay after the final (capped) attempt
})
