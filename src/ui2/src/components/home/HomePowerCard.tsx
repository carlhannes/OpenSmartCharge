import { useOsc } from "@/lib/mock/store";
import { fmtKW } from "@/lib/format";
import { useEffect, useState } from "react";

// Live "Home now" card — whole-house draw with a rolling sparkline. Fed by the `housePowerW` store
// scalar (patched from the meter.snapshot SSE / getMeter in live, or the mock tick in demo).
export function HomePowerCard() {
  const housePowerW = useOsc((s) => s.housePowerW);
  const housePowerSeq = useOsc((s) => s.housePowerSeq);
  const chargers = useOsc((s) => s.chargers);
  const [samples, setSamples] = useState<number[]>([]);

  // Append one sample per meter reading (keyed on seq, so a steady load still draws a flat line).
  useEffect(() => {
    if (housePowerW == null) return;
    setSamples((prev) => [...prev, housePowerW].slice(-40));
  }, [housePowerSeq, housePowerW]);

  if (housePowerW == null) return null;

  const evW = chargers.reduce((a, c) => a + (c.currentPowerW > 0 ? c.currentPowerW : 0), 0);

  let points = "";
  if (samples.length >= 2) {
    const max = Math.max(...samples);
    const min = Math.min(...samples);
    points = samples
      .map((v, i) => {
        const x = (i / (samples.length - 1)) * 100;
        const y = 100 - ((v - min) / (max - min || 1)) * 100;
        return `${x},${y}`;
      })
      .join(" ");
  }

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
      {points && (
        <div className="mt-3 h-10">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
            <polyline
              points={points}
              fill="none"
              className="stroke-primary"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      )}
      {evW > 0 && (
        <div className="mt-2 text-xs text-muted-foreground">incl. {fmtKW(evW)} to your car</div>
      )}
    </div>
  );
}
