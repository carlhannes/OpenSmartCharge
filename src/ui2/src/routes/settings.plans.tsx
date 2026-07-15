import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useOsc } from "@/lib/mock/store";
import { addPlan as addPlanCmd } from "@/lib/live/commands";
import { PlanRow } from "@/components/charger/ChargerDetail";

export const Route = createFileRoute("/settings/plans")({
  component: PlansSettings,
});

// Global plan management. The same PlanRow editor used at the charger renders here, but unfiltered —
// every plan, whatever car it targets. (At a charger you only see the plans matching the active car.)
function PlansSettings() {
  const plans = useOsc((s) => s.plans);
  const vehicles = useOsc((s) => s.vehicles);
  // Plans still hang off a loadpoint in the backend; a global add attaches to the first charger and
  // to "any car" (empty target set) — the target chips below then narrow it to specific vehicles.
  const chargerId = useOsc((s) => s.chargers[0]?.id);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Every charge plan. Each targets one or more cars (or any car); at a charger you only see
          the plans matching the active car. Reaching a target pauses charging when its switch is
          on.
        </p>
        {chargerId && (
          <button
            onClick={() => void addPlanCmd(chargerId, [])}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> Add plan
          </button>
        )}
      </div>

      {plans.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No charge plans yet. Add one to schedule a target.
        </div>
      ) : (
        <div className="space-y-3">
          {plans.map((p) => (
            <PlanRow key={p.id} planId={p.id} vehicles={vehicles} />
          ))}
        </div>
      )}
    </div>
  );
}
