/**
 * createDebouncedSetter — rate-limits calls to an async write function.
 *
 * Guarantees:
 * - Duplicate values (value === lastWritten) are dropped entirely.
 * - Writes are separated by at least minIntervalMs.
 * - If a write is suppressed by the interval guard, the most-recent value is
 *   coalesced into a single trailing write at the end of the cooldown.
 * - Multiple coalesced changes collapse to one write (last value wins).
 *
 * Dependencies (now, schedule, write) are injected for testability.
 */
export function createDebouncedSetter(opts: {
  minIntervalMs: number
  now: () => number
  schedule: (fn: () => void, delayMs: number) => unknown
  write: (value: number) => Promise<void>
}): (value: number) => Promise<void> {
  const { minIntervalMs, now, schedule, write } = opts
  let lastWritten: number | undefined
  let lastWriteAt = 0
  let pendingValue: number | undefined
  let pendingScheduled = false

  return async function set(value: number): Promise<void> {
    if (value === lastWritten) return

    const elapsed = now() - lastWriteAt
    if (elapsed >= minIntervalMs) {
      lastWritten = value
      lastWriteAt = now()
      await write(value)
      return
    }

    // Coalesce into a single trailing write
    pendingValue = value
    if (pendingScheduled) return
    pendingScheduled = true
    schedule(() => {
      pendingScheduled = false
      if (pendingValue === undefined || pendingValue === lastWritten) {
        pendingValue = undefined
        return
      }
      const final = pendingValue
      pendingValue = undefined
      lastWritten = final
      lastWriteAt = now()
      void write(final).catch(() => {})
    }, minIntervalMs - elapsed)
  }
}
