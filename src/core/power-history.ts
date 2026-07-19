// Rolling in-memory whole-house power buffer for the ui2 "Home now" chart. The lifecycle appends a
// sample on each meter reading (whole-house total + the car's share); GET /api/power-history serves it so
// the chart shows the last 15 min immediately on refresh (the client then keeps it live via the SSE).
// In-memory only — a restart starts it empty (it refills within the window; no persistence needed).

export interface PowerSample {
  t: number // epoch ms
  total: number // whole-house draw (W)
  ev: number // car charging (W) — a subset of total
}

const WINDOW_MS = 15 * 60_000
const MIN_INTERVAL_MS = 10_000 // meter path is ~1 Hz; one sample per ~10 s is plenty for a 15-min chart

/**
 * Append a sample, MUTATING `buf` in place so a reference held elsewhere (the API layer) stays valid.
 * Throttled to ~10 s (skips if the last sample is more recent) and pruned to the 15-min window.
 */
export function pushPowerSample(buf: PowerSample[], total: number, ev: number, now: number): void {
  const last = buf[buf.length - 1]
  if (last && now - last.t < MIN_INTERVAL_MS) return
  buf.push({ t: now, total, ev })
  const cutoff = now - WINDOW_MS
  while (buf.length > 0 && buf[0].t < cutoff) buf.shift()
}
