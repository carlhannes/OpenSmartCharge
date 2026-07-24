import { backoffDelayMs, type BackoffCfg } from './source-reconciler.js'

// Runs each module's optional `postStartup()` hook once after the whole system is up, retrying
// failures with capped exponential backoff. The lifecycle owns the WHEN (this runner) — modules stay
// timerless mappers. See ModuleLifecycle.postStartup in src/sdk/types.ts.
//
// Kept separate from lifecycle.ts + given an injectable `delay` so the retry loop is unit-testable
// without real timers (pass `delay: () => Promise.resolve()` to run all attempts synchronously).

export interface PostStartupModule {
  readonly id: string
  postStartup?(): Promise<void>
}

export interface PostStartupOpts {
  cfg: BackoffCfg
  /** Give up after this many attempts (a module still failing is logged, not retried forever). */
  maxAttempts: number
  /** Injectable wait between retry rounds (real: setTimeout-backed; test: resolve immediately). */
  delay: (ms: number) => Promise<void>
  log: { warn: (obj: object, msg: string) => void }
}

/**
 * Call `postStartup()` on every module that has one; on failure keep it pending and retry the still-
 * failing set after `backoffDelayMs(attempt)`, up to `maxAttempts`. Succeeded modules drop out (the
 * hook is idempotent, but we don't re-poll). Resolves when nothing is pending or the cap is hit —
 * fire-and-forget in production (`void runPostStartup(...)`), awaitable in tests.
 */
export async function runPostStartup(
  modules: PostStartupModule[],
  opts: PostStartupOpts,
): Promise<void> {
  let pending = modules.filter((m) => typeof m.postStartup === 'function')
  for (let attempt = 1; pending.length > 0 && attempt <= opts.maxAttempts; attempt++) {
    const failed: PostStartupModule[] = []
    for (const m of pending) {
      try {
        await m.postStartup!()
      } catch (err) {
        opts.log.warn({ err, module: m.id, attempt }, 'postStartup failed — will retry')
        failed.push(m)
      }
    }
    pending = failed
    if (pending.length > 0 && attempt < opts.maxAttempts) {
      await opts.delay(backoffDelayMs(attempt, opts.cfg))
    }
  }
  if (pending.length > 0) {
    opts.log.warn(
      { modules: pending.map((m) => m.id), attempts: opts.maxAttempts },
      'postStartup gave up after max attempts',
    )
  }
}
