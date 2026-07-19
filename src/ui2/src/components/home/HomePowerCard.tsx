import { useOsc } from "@/lib/mock/store";
import { fmtKW } from "@/lib/format";
import { useMemo } from "react";

const CHART_H = 128; // px
const WINDOW_MS = 15 * 60_000;
const VOLTAGE = 230;

// Live "Home now" card: a stacked AREA chart of the last 15 min of whole-house power, split into the home
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

  // Build stacked-area geometry directly from the raw samples over [now−15min, now] (no bucketing — an
  // area renders the dense ~10 s samples smoothly). Recomputes on each new sample / capacity change.
  const area = useMemo(() => {
    const now = Date.now();
    const start = now - WINDOW_MS;
    const pts = history.filter((s) => s.t >= start);
    if (pts.length < 2) return null;
    const xOf = (t: number) => Math.max(0, Math.min(100, ((t - start) / WINDOW_MS) * 100));
    const yOf = (w: number) => 100 - Math.max(0, Math.min(100, (w / maxW) * 100));
    const baseTop = pts.map((s) => `${xOf(s.t)},${yOf(Math.max(0, s.total - s.ev))}`);
    const stackTop = pts.map((s) => `${xOf(s.t)},${yOf(s.total)}`); // total = base + car
    const x0 = xOf(pts[0].t);
    const xN = xOf(pts[pts.length - 1].t);
    return {
      base: `${x0},100 ${baseTop.join(" ")} ${xN},100`, // baseline → base curve → baseline
      car: `${baseTop.join(" ")} ${[...stackTop].reverse().join(" ")}`, // band between base + total
      top: stackTop.join(" "),
    };
  }, [history, maxW]);

  if (housePowerW == null) return null;

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

      {area ? (
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
                {/* stacked areas: base load (gray) + car (green) on top, with a crisp top edge */}
                <polygon points={area.base} className="fill-muted-foreground/40" />
                <polygon points={area.car} className="fill-primary/75" />
                <polyline
                  points={area.top}
                  fill="none"
                  className="stroke-primary"
                  strokeWidth={1.2}
                  vectorEffect="non-scaling-stroke"
                />
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

      {/* colour key */}
      <div className="mt-3 flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-muted-foreground" /> Home
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-primary" /> Car
        </span>
      </div>
    </div>
  );
}
