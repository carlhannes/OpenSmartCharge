import { useOsc } from "@/lib/mock/store";
import { useMemo } from "react";

interface Props {
  chargerId: string;
  height?: number;
}

// The "Next 24 hours · price & plan" chart. Everything is backend-derived: the price series AND the
// shaded charge slots come from GET /api/loadpoints/:name/plan (the planner's real deadline-aware
// schedule), mapped into the store as `loadpointPlans[chargerId]`. No client-side "cheap window" guess.
// Rendered on a true rolling now→now+24h time axis (not a clock 00-24 axis).
export function Timeline24h({ chargerId, height = 140 }: Props) {
  const plan = useOsc((s) => s.loadpointPlans[chargerId]);
  // Currency symbol from the tariff the backend reports (e.g. SEK → "kr"); derived into config by useLiveSync.
  const currency = useOsc((s) => s.config.currencySymbol);
  const tz = useOsc((s) => s.timezone); // labels in the SITE timezone, never the browser's

  const view = useMemo(() => {
    if (!plan || plan.slots.length === 0) return null;
    const { fromMs, toMs, slots, readyByMs } = plan;
    const span = toMs - fromMs || 1;
    const xOf = (ms: number) => Math.max(0, Math.min(100, ((ms - fromMs) / span) * 100));
    const prices = slots.map((s) => s.price);
    const max = Math.max(...prices);
    const min = Math.min(...prices);
    // Expensive at the top, cheap dipping to the bottom (SVG y=0 is the top).
    const points = slots
      .map((s) => `${xOf((s.startMs + s.endMs) / 2)},${((max - s.price) / (max - min || 1)) * 100}`)
      .join(" ");
    const charge = slots
      .filter((s) => s.charge)
      .map((s) => ({ x: xOf(s.startMs), w: xOf(s.endMs) - xOf(s.startMs) }));
    const fmtH = (ms: number) =>
      new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(
        new Date(ms),
      );
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => fmtH(fromMs + f * span));
    return {
      max,
      min,
      points,
      charge,
      ticks,
      fromMs,
      span,
      readyByX: readyByMs != null ? xOf(readyByMs) : null,
    };
  }, [plan, tz]);

  const nowX = view
    ? Math.max(0, Math.min(100, ((Date.now() - view.fromMs) / view.span) * 100))
    : 0;

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4">
      <div className="mb-3 flex items-center justify-between text-xs">
        <span className="font-medium text-muted-foreground">Next 24 hours · price & plan</span>
        <span className="text-muted-foreground">
          <span className="mr-3">
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-primary/70 align-middle" />
            charge window
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent align-middle" />
            ready by
          </span>
        </span>
      </div>
      {view == null ? (
        <div
          className="grid place-items-center rounded-xl bg-secondary/40 text-xs text-muted-foreground"
          style={{ height }}
        >
          No price data yet
        </div>
      ) : (
        <>
          <div className="relative" style={{ height }}>
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="absolute inset-0 h-full w-full"
            >
              {/* backend-selected charge slots */}
              {view.charge.map((r, i) => (
                <rect key={i} x={r.x} y={0} width={r.w} height={100} className="fill-primary/10" />
              ))}
              {/* price curve */}
              <polyline
                points={view.points}
                fill="none"
                className="stroke-primary"
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
              />
              {/* now line */}
              <line
                x1={nowX}
                x2={nowX}
                y1={0}
                y2={100}
                className="stroke-foreground/60"
                strokeWidth={1}
                strokeDasharray="2 2"
                vectorEffect="non-scaling-stroke"
              />
              {/* ready-by marker */}
              {view.readyByX != null && (
                <line
                  x1={view.readyByX}
                  x2={view.readyByX}
                  y1={0}
                  y2={100}
                  className="stroke-accent"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
          </div>
          <div className="mt-2 flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
            {view.ticks.map((t, i) => (
              <span key={i}>{t}</span>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              Cheapest ≈ {view.min.toFixed(2)} {currency}/kWh
            </span>
            <span className="text-muted-foreground">
              Peak ≈ {view.max.toFixed(2)} {currency}/kWh
            </span>
          </div>
        </>
      )}
    </div>
  );
}
