import { createFileRoute } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { REGIONS } from "@/lib/copy";

export const Route = createFileRoute("/settings/region")({ component: RegionSettings });

function RegionSettings() {
  const region = useOsc((s) => s.config.region);
  const setConfig = useOsc((s) => s.setConfig);
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Your electricity price zone — used to fetch day-ahead prices.
      </p>
      <div className="mt-4 space-y-2">
        {REGIONS.map((r) => (
          <button
            key={r.id}
            onClick={() => setConfig({ region: r.id })}
            className={`flex w-full items-center justify-between rounded-2xl border p-4 text-left transition ${
              region === r.id
                ? "border-primary bg-primary/5"
                : "border-border/60 bg-card hover:bg-secondary/40"
            }`}
          >
            <span className="font-medium">{r.label}</span>
            {region === r.id && <span className="text-primary">✓</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
