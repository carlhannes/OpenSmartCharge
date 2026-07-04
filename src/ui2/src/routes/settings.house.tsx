import { createFileRoute } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";

export const Route = createFileRoute("/settings/house")({ component: HouseSettings });

function HouseSettings() {
  const config = useOsc((s) => s.config);
  const setConfig = useOsc((s) => s.setConfig);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <label className="mb-1 block text-xs uppercase tracking-widest text-muted-foreground">
          Main breaker
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={6}
            max={200}
            value={config.breakerAmps}
            onChange={(e) => setConfig({ breakerAmps: parseInt(e.target.value, 10) || 0 })}
            className="w-24 rounded-lg border border-input bg-background px-3 py-2 text-sm tabular-nums"
          />
          <span className="text-sm text-muted-foreground">A</span>
        </div>
      </div>

      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="mb-3 font-medium">Where do we read the house load from?</div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          {[
            { id: "tibber", label: "Tibber Pulse", desc: "Live per-phase currents." },
            { id: "mqtt", label: "MQTT meter", desc: "DSMR / OBIS bridge." },
            { id: "static", label: "Safe static limit", desc: "No live meter needed." },
          ].map((o) => (
            <button
              key={o.id}
              onClick={() => setConfig({ balancerMode: o.id as never })}
              className={`rounded-2xl border p-4 text-left transition ${
                config.balancerMode === o.id
                  ? "border-primary bg-primary/5"
                  : "border-border/60 hover:bg-secondary/40"
              }`}
            >
              <div className="text-sm font-medium">{o.label}</div>
              <div className="text-xs text-muted-foreground">{o.desc}</div>
            </button>
          ))}
        </div>

        {config.balancerMode === "static" && (
          <div className="mt-4">
            <label className="mb-1 block text-xs uppercase tracking-widest text-muted-foreground">
              Safe limit
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={6}
                max={32}
                value={config.staticLimitA}
                onChange={(e) => setConfig({ staticLimitA: parseInt(e.target.value, 10) })}
                className="flex-1 accent-primary"
              />
              <span className="w-14 text-right tabular-nums">{config.staticLimitA} A</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
