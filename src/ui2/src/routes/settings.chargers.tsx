import { createFileRoute, Link } from "@tanstack/react-router";
import { useOsc, type Charger, type Plan } from "@/lib/mock/store";
import { Trash2, Undo2 } from "lucide-react";
import { useRef, useState } from "react";

export const Route = createFileRoute("/settings/chargers")({ component: ChargersSettings });

function ChargersSettings() {
  const chargers = useOsc((s) => s.chargers);
  const allPlans = useOsc((s) => s.plans);
  const rename = useOsc((s) => s.renameCharger);
  const setAmps = useOsc((s) => s.setChargerMaxAmps);
  const remove = useOsc((s) => s.removeCharger);
  const restore = useOsc((s) => s.restoreCharger);
  const pending = useOsc((s) => s.pendingChargers);
  const emit = useOsc((s) => s.emitPending);
  const claim = useOsc((s) => s.claimPending);

  const [undo, setUndo] = useState<{ charger: Charger; plans: Plan[] } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const removeCharger = (c: Charger) => {
    const plans = allPlans.filter((p) => p.chargerId === c.id);
    remove(c.id);
    setUndo({ charger: c, plans });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
  };
  const undoRemove = () => {
    if (!undo) return;
    restore(undo.charger, undo.plans);
    setUndo(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
  };

  return (
    <div className="space-y-4">
      {undo && (
        <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-secondary px-4 py-3 text-sm">
          <span>
            Removed <span className="font-medium">{undo.charger.name}</span>
          </span>
          <button
            onClick={undoRemove}
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            <Undo2 className="h-3.5 w-3.5" /> Undo
          </button>
        </div>
      )}

      {chargers.map((c) => (
        <div key={c.id} className="rounded-2xl border border-border/60 bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <input
              value={c.name}
              onChange={(e) => rename(c.id, e.target.value)}
              className="w-full bg-transparent font-display text-lg font-semibold outline-none"
            />
            <button
              onClick={() => removeCharger(c)}
              aria-label={`Remove ${c.name}`}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <label className="mb-1 block text-xs text-muted-foreground">Max amps</label>
          <input
            type="number"
            min={6}
            max={32}
            value={c.maxAmps}
            onChange={(e) => setAmps(c.id, parseInt(e.target.value, 10) || 0)}
            className="w-32 rounded-lg border border-input bg-background px-3 py-2 text-sm tabular-nums outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
      ))}

      <div className="rounded-2xl border border-dashed border-border p-5">
        <div className="mb-2 font-medium">Pending connections</div>
        {pending.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No unclaimed chargers.
            <button onClick={() => emit()} className="ml-2 text-primary hover:underline">
              Simulate one
            </button>
          </div>
        )}
        {pending.map((p) => (
          <div
            key={p.id}
            className="mt-2 flex items-center justify-between rounded-xl bg-secondary p-3"
          >
            <div className="text-sm">
              ✓ Detected <span className="font-mono">{p.stationId}</span>
            </div>
            <button
              onClick={() => claim(p.id, p.stationId, 16)}
              className="rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
            >
              Claim
            </button>
          </div>
        ))}
      </div>

      <Link
        to="/onboarding/$step"
        params={{ step: "charger" }}
        className="block rounded-2xl bg-primary py-3 text-center text-sm font-medium text-primary-foreground"
      >
        Add another charger
      </Link>
    </div>
  );
}
