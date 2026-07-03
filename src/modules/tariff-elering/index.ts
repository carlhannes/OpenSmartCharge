import { registerTariff } from '../../sdk/registry-api.js'
import type { ModuleHealth } from '../../sdk/types.js'
import { fetchEleringPrices, EleringZoneError } from './api.js'
import { upsertSlots, getSlots, latestSlotEnd } from './persistence.js'
import { nextDelay } from './scheduler.js'
import type { SchedulerState } from './scheduler.js'
import { isPastPublishWindow } from './scheduler.js'

registerTariff({
  type: 'elering',

  create(cfg, ctx) {
    const config = cfg as { name: string; zone: string }
    if (!config.name || !config.zone) {
      throw new Error('tariff-elering: config must have name and zone')
    }
    const { name, zone } = config

    const state: SchedulerState = { consecutiveFailures: 0 }
    let timer: ReturnType<typeof setTimeout> | undefined
    let health: ModuleHealth = 'unavailable'

    // Returns fetch range: current hour (truncated) → +48h
    function fetchRange(): { from: Date; to: Date } {
      const from = new Date()
      from.setMinutes(0, 0, 0)
      return { from, to: new Date(from.getTime() + 48 * 3600_000) }
    }

    // Returns true when cached data extends >20h into the future (covers tomorrow)
    function haveTomorrow(): boolean {
      const latest = latestSlotEnd(ctx.db, zone)
      return latest !== null && latest.getTime() > Date.now() + 20 * 3600_000
    }

    function computeHealth(): ModuleHealth {
      const now = new Date()
      const latest = latestSlotEnd(ctx.db, zone)
      if (!latest || latest.getTime() <= now.getTime()) return 'unavailable'
      // Before publish window: having today's data is fine
      if (!isPastPublishWindow(now)) return 'ok'
      // After publish window: we should have tomorrow; if not → degraded
      return haveTomorrow() ? 'ok' : 'degraded'
    }

    function scheduleNext(): void {
      const decision = nextDelay(state, haveTomorrow(), new Date())
      ctx.log.info({ name, zone, decision }, 'Elering: next fetch scheduled')
      timer = setTimeout(() => {
        void runOnce(true)
      }, decision.delayMs)
    }

    // scheduled=true → use ctx.fetch (jitter-enabled) for thundering-herd prevention
    // scheduled=false → use global fetch (startup: immediate)
    async function runOnce(scheduled: boolean): Promise<void> {
      const { from, to } = fetchRange()
      try {
        const fetchFn = scheduled ? ctx.fetch : globalThis.fetch
        const slots = await fetchEleringPrices(zone, from, to, fetchFn)
        upsertSlots(ctx.db, zone, slots)
        state.consecutiveFailures = 0
        health = computeHealth()
        ctx.log.info({ name, zone, slots: slots.length }, 'Elering prices updated')
        ctx.events.emit('tariff.updated', { name, zone })
      } catch (err) {
        if (err instanceof EleringZoneError) {
          // Permanent: wrong zone configured — don't retry, just log
          ctx.log.error({ err, zone }, 'Elering: zone not found — check your config')
          health = computeHealth()
          return
        }
        state.consecutiveFailures++
        health = computeHealth()
        ctx.log.warn(
          { err, zone, consecutiveFailures: state.consecutiveFailures },
          'Elering fetch failed',
        )
      }
      scheduleNext()
    }

    return {
      get id() {
        return name
      },

      async start() {
        // Immediate startup fetch (no jitter — user wants data right away)
        await runOnce(false)
      },

      async stop() {
        if (timer !== undefined) clearTimeout(timer)
      },

      health() {
        return health
      },

      async prices(from, to) {
        return getSlots(ctx.db, zone, from, to)
      },
    }
  },
})
