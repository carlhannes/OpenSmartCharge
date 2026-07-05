import { createFileRoute } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { REGIONS } from "@/lib/copy";
import { ConfigLockNote } from "@/components/settings/ConfigLockNote";

export const Route = createFileRoute("/settings/region")({ component: RegionSettings });

function RegionSettings() {
  const region = useOsc((s) => s.config.region);
  const setConfig = useOsc((s) => s.setConfig);
  // Live backend → this is read-only (no write API); the value is the real tariff zone from
  // /api/site. In demo mode it stays an interactive local playground.
  const locked = useOsc((s) => s.source === "live");
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Your electricity price zone — used to fetch day-ahead prices.
      </p>
      {locked && <ConfigLockNote />}
      <div className="mt-4 space-y-2">
        {REGIONS.map((r) => (
          <button
            key={r.id}
            onClick={locked ? undefined : () => setConfig({ region: r.id })}
            disabled={locked}
            className={`flex w-full items-center justify-between rounded-2xl border p-4 text-left transition ${
              region === r.id ? "border-primary bg-primary/5" : "border-border/60 bg-card"
            } ${locked ? "cursor-default" : "hover:bg-secondary/40"}`}
          >
            <span className="font-medium">{r.label}</span>
            {region === r.id && <span className="text-primary">✓</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
