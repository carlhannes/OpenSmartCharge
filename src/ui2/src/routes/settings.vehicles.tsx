import { createFileRoute } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { removeVehicle } from "@/lib/live/commands";
import { VehicleForm } from "@/components/VehicleForm";
import { Trash2, Pencil } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/settings/vehicles")({ component: VehiclesSettings });

function VehiclesSettings() {
  const vehicles = useOsc((s) => s.vehicles);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {vehicles.map((v) => (
        <div key={v.id} className="rounded-2xl border border-border/60 bg-card p-4">
          {editingId === v.id ? (
            <VehicleForm mode="edit" existing={v} onDone={() => setEditingId(null)} />
          ) : (
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">
                  🚗 {v.brand ? `${v.brand} ` : ""}
                  {v.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {v.hasTelemetry
                    ? `SoC ${Math.round(v.soc)}% · ${Math.round(v.rangeKm)} km · ${v.batteryKwh} kWh`
                    : "Manual — no app; select it by hand, plans target kWh only"}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setEditingId(v.id)}
                  aria-label={`Edit ${v.name}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => void removeVehicle(v.id)}
                  aria-label={`Remove ${v.name}`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <VehicleForm mode="create" />
      </div>
    </div>
  );
}
