import { useOsc } from "@/lib/mock/store";
import { fmtKW } from "@/lib/format";
import { useMemo } from "react";

const CHART_H = 128; // px
const BINS = 30; // 30 bars over the window → 30 s each
const WINDOW_MS = 15 * 60_000;
const VOLTAGE = 230;
const GAP_V = 1.2; // surface gap (0-100 units) between the base + car segments so they stay distinct

// Live "Home now" card: a stacked bar chart of the last 15 min of whole-house power, split into the home
// base load (gray) and the car's charging (green), on a fixed 0→breaker-capacity kW axis. Fed by the
// store's `powerHistory` buffer (the meter.snapshot SSE in live; the mock tick in demo).
export function HomePowerCard() {
  const housePowerW = useOsc((s) => s.housePowerW);
  const history = useOsc((s) => s.powerHistory);
  const chargers = useOsc((s) => s.chargers);
  const breakerAmps = useOsc((s) => s.config.breakerAmps);
  const phases = useOsc((s) => s.config.phases);

  const evW = chargers.reduce((a, c) => a + (c.currentPowerW > 0 ? c.currentPowerW : 0), 0);
  const maxKW = Math.max(1, (breakerAmps * phases * VOLTAGE) / 1000);
  const maxW = maxKW * 1000;

  // Bucket the rolling history into fixed time bins over [now−15min, now]; each bar = mean power in its
  // bin, split base (total−car) + car. Empty bins render as gaps. Recomputes each sample (history change).
  const bars = useMemo(() => {
    const now = Date.now();
    const start = now - WINDOW_MS;
    const binMs = WINDOW_MS / BINS;
    const acc = Array.from({ length: BINS }, () => ({ total: 0, ev: 0, n: 0 }));
    for (const s of history) {
      if (s.t < start) continue;
      const idx = Math.min(BINS - 1, Math.floor((s.t - start) / binMs));
      acc[idx].total += s.total;
      acc[idx].ev += s.ev;
      acc[idx].n += 1;
    }
    return acc.map((b) => {
      if (b.n === 0) return null;
      const total = b.total / b.n;
      const ev = Math.min(total, b.ev / b.n); // car can't exceed the whole-house total
      return { base: Math.max(0, total - ev), ev };
    });
  }, [history]);

  if (housePowerW == null) return null;

  const binW = 100 / BINS;
  const barW = binW * 0.82; // ~18% inter-bar surface gap
  const barX = (i: number) => i * binW + binW * 0.09;
  const hPct = (w: number) => Math.min(100, (w / maxW) * 100);
  const hasData = bars.some((b) => b !== null);

  return (
    <div className="mx-5 mb-4 rounded-3xl border border-border/60 bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Home now
        </div>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="h-2 w-2 animate-pulse rounded-full bg-status-ok" />
          live
        </span>
      </div>

      <div className="mt-1 font-display text-3xl font-semibold tabular-nums">
        {fmtKW(housePowerW)}
      </div>
      {evW > 0 && (
        <div className="mt-0.5 text-xs text-muted-foreground">incl. {fmtKW(evW)} to your car</div>
      )}

      {/* legend */}
      <div className="mt-3 flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-muted-foreground" /> Home
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-primary" /> Car
        </span>
      </div>

      {hasData ? (
        <div className="mt-2 flex gap-2">
          {/* Y axis (kW) */}
          <div
            className="flex w-10 flex-col justify-between text-right text-[10px] tabular-nums text-muted-foreground"
            style={{ height: CHART_H }}
          >
            <span>{maxKW.toFixed(0)} kW</span>
            <span>{(maxKW / 2).toFixed(maxKW < 10 ? 1 : 0)}</span>
            <span>0</span>
          </div>
          <div className="flex-1">
            <div className="relative" style={{ height: CHART_H }}>
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="absolute inset-0 h-full w-full"
              >
                {/* recessive gridlines at 0 / 50 / 100 % of capacity */}
                {[0, 50, 100].map((y) => (
                  <line
                    key={y}
                    x1={0}
                    x2={100}
                    y1={y}
                    y2={y}
                    className="stroke-border/60"
                    strokeWidth={0.5}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {bars.map((b, i) => {
                  if (!b) return null;
                  const baseH = hPct(b.base);
                  const gap = baseH > 0 && b.ev > 0 ? GAP_V : 0;
                  const evH = Math.max(0, Math.min(100 - baseH - gap, hPct(b.ev)));
                  const x = barX(i);
                  return (
                    <g key={i}>
                      {baseH > 0 && (
                        <rect
                          x={x}
                          y={100 - baseH}
                          width={barW}
                          height={baseH}
                          className="fill-muted-foreground"
                        />
                      )}
                      {evH > 0 && (
                        <rect
                          x={x}
                          y={100 - baseH - gap - evH}
                          width={barW}
                          height={evH}
                          className="fill-primary"
                        />
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>
            {/* X axis (time) */}
            <div className="mt-1 flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>15m</span>
              <span>10m</span>
              <span>5m</span>
              <span>now</span>
            </div>
          </div>
        </div>
      ) : (
        <div
          className="mt-2 grid place-items-center rounded-xl bg-secondary/40 text-xs text-muted-foreground"
          style={{ height: CHART_H }}
        >
          Gathering readings…
        </div>
      )}
    </div>
  );
}
