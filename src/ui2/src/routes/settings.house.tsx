import { createFileRoute } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { setBreaker, setSiteName, setSmartCharging } from "@/lib/live/commands";
import { fmtKW } from "@/lib/format";

export const Route = createFileRoute("/settings/house")({ component: HouseSettings });

const SOURCES = [
  { id: "tibber", label: "Tibber Pulse", desc: "Live per-phase currents." },
  { id: "mqtt", label: "MQTT meter", desc: "DSMR / OBIS bridge." },
  { id: "static", label: "Safe static limit", desc: "No live meter — uses the fallback below." },
] as const;

function HouseSettings() {
  const config = useOsc((s) => s.config);
  const setConfig = useOsc((s) => s.setConfig);
  const housePowerW = useOsc((s) => s.housePowerW);
  // Switching the meter *source type* is a module swap (no single-call API yet) → read-only in live;
  // it reflects the actual configured meter. The breaker + fallback margins below ARE editable live.
  const sourceLocked = useOsc((s) => s.source === "live");

  const breaker = config.breakerAmps;
  const nightMargin = config.nightMarginA ?? 3;
  const daytimeFraction = config.daytimeFraction ?? 0.5;
  const nightCap = Math.max(0, breaker - nightMargin);
  const dayCap = Math.round(breaker * daytimeFraction);

  return (
    <div className="space-y-4">
      {/* Home / installation name */}
      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <label className="mb-1 block text-xs uppercase tracking-widest text-muted-foreground">
          Home name
        </label>
        <input
          type="text"
          value={config.homeName ?? ""}
          placeholder="OpenSmartCharge"
          onChange={(e) => setConfig({ homeName: e.target.value })}
          onBlur={(e) => void setSiteName(e.target.value.trim() || "OpenSmartCharge")}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
        />
        <p className="mt-2 text-xs text-muted-foreground">
          A friendly name for this installation — shows in config backups and Home Assistant.
        </p>
      </div>

      {/* Main breaker / circuit ceiling */}
      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <label className="mb-1 block text-xs uppercase tracking-widest text-muted-foreground">
          Main breaker (circuit ceiling)
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={6}
            max={200}
            value={breaker}
            onChange={(e) => setConfig({ breakerAmps: parseInt(e.target.value, 10) || 0 })}
            onBlur={(e) => void setBreaker(parseInt(e.target.value, 10) || breaker)}
            className="w-24 rounded-lg border border-input bg-background px-3 py-2 text-sm tabular-nums"
          />
          <span className="text-sm text-muted-foreground">A per phase</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          OSC never lets total draw exceed this — it's the ceiling everything else scales from.
        </p>
      </div>

      {/* House load source (the meter) */}
      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="font-medium">Where we read the house load from</div>
          {housePowerW != null && (
            <div className="shrink-0 text-xs text-muted-foreground">
              House now ·{" "}
              <span className="font-display text-sm font-semibold tabular-nums text-foreground">
                {fmtKW(housePowerW)}
              </span>
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          {SOURCES.map((o) => (
            <button
              key={o.id}
              onClick={sourceLocked ? undefined : () => setConfig({ balancerMode: o.id })}
              disabled={sourceLocked}
              className={`rounded-2xl border p-4 text-left transition ${
                config.balancerMode === o.id ? "border-primary bg-primary/5" : "border-border/60"
              } ${sourceLocked ? "cursor-default disabled:opacity-100" : "hover:bg-secondary/40"}`}
            >
              <div className="text-sm font-medium">{o.label}</div>
              <div className="text-xs text-muted-foreground">{o.desc}</div>
            </button>
          ))}
        </div>
        {sourceLocked && (
          <p className="mt-2 text-xs text-muted-foreground">
            This reflects your configured meter. Switching the source type in-app is coming soon —
            change it in your config (or import a backup) for now.
          </p>
        )}
      </div>

      {/* Safe fallback (used when there's no live meter reading) */}
      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="mb-1 font-medium">Safe fallback (when no live meter)</div>
        <p className="mb-3 text-xs text-muted-foreground">
          If the meter goes stale (or you have none), OSC caps charging conservatively: at night up
          to <span className="font-medium tabular-nums">{nightCap} A</span> (breaker − margin), by
          day up to <span className="font-medium tabular-nums">{dayCap} A</span> (breaker ×
          fraction).
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs uppercase tracking-widest text-muted-foreground">
              Night margin (A)
            </label>
            <input
              type="number"
              min={0}
              max={breaker}
              value={nightMargin}
              onChange={(e) => setConfig({ nightMarginA: parseFloat(e.target.value) || 0 })}
              onBlur={(e) =>
                void setSmartCharging({ nightMarginA: parseFloat(e.target.value) || 0 })
              }
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm tabular-nums"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase tracking-widest text-muted-foreground">
              Daytime fraction
            </label>
            <input
              type="number"
              min={0.1}
              max={1}
              step={0.05}
              value={daytimeFraction}
              onChange={(e) => setConfig({ daytimeFraction: parseFloat(e.target.value) || 0 })}
              onBlur={(e) =>
                void setSmartCharging({
                  daytimeFraction: Math.min(1, Math.max(0.1, parseFloat(e.target.value) || 0.5)),
                })
              }
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm tabular-nums"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
