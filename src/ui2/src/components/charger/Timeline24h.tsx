import { useOsc } from "@/lib/mock/store";
import { cheapWindows } from "@/lib/mock/prices";
import { useMemo } from "react";

interface Props {
  readyByHour?: number;
  height?: number;
}

export function Timeline24h({ readyByHour, height = 140 }: Props) {
  const prices = useOsc((s) => s.prices);
  // Currency symbol from the tariff the backend reports (e.g. SEK → "kr"); NOT hardcoded € — the
  // app derives it into config via useLiveSync (currencySymbol(slots[0].currency)).
  const currency = useOsc((s) => s.config.currencySymbol);
  const nowH = new Date().getHours() + new Date().getMinutes() / 60;

  const { max, min, windows, points } = useMemo(() => {
    const max = Math.max(...prices);
    const min = Math.min(...prices);
    const windows = cheapWindows(prices);
    const points = prices
      .map((p, i) => {
        const x = (i / 23) * 100;
        const y = ((max - p) / (max - min || 1)) * 100;
        return `${x},${y}`;
      })
      .join(" ");
    return { max, min, windows, points };
  }, [prices]);

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4">
      <div className="mb-3 flex items-center justify-between text-xs">
        <span className="font-medium text-muted-foreground">Next 24 hours · price & plan</span>
        <span className="text-muted-foreground">
          <span className="mr-3">
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-primary/70 align-middle" />
            cheap window
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent align-middle" />
            ready by
          </span>
        </span>
      </div>
      <div className="relative" style={{ height }}>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          {/* cheap windows */}
          {windows.map(([a, b], i) => (
            <rect
              key={i}
              x={(a / 24) * 100}
              y={0}
              width={((b - a) / 24) * 100}
              height={100}
              className="fill-primary/10"
            />
          ))}
          {/* price curve */}
          <polyline
            points={points}
            fill="none"
            className="stroke-primary"
            strokeWidth={1.2}
            vectorEffect="non-scaling-stroke"
          />
          {/* now line */}
          <line
            x1={(nowH / 24) * 100}
            x2={(nowH / 24) * 100}
            y1={0}
            y2={100}
            className="stroke-foreground/60"
            strokeWidth={1}
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
          {/* ready-by marker */}
          {readyByHour != null && (
            <line
              x1={(readyByHour / 24) * 100}
              x2={(readyByHour / 24) * 100}
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
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          Cheapest hour ≈ {min.toFixed(2)} {currency}/kWh
        </span>
        <span className="text-muted-foreground">
          Peak ≈ {max.toFixed(2)} {currency}/kWh
        </span>
      </div>
    </div>
  );
}
