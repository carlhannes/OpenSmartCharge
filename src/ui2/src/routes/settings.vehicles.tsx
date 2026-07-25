import { createFileRoute } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { removeVehicle, renameVehicle } from "@/lib/live/commands";
import { VehicleForm } from "@/components/VehicleForm";
import { Trash2, Pencil } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/settings/vehicles")({ component: VehiclesSettings });

function VehiclesSettings() {
  const vehicles = useOsc((s) => s.vehicles);
  const renameLocal = useOsc((s) => s.updateVehicle); // optimistic display rename (keyed by id)
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {vehicles.map((v) => (
        <div key={v.id} className="rounded-2xl border border-border/60 bg-card p-4">
          {editingId === v.id ? (
            <VehicleForm mode="edit" existing={v} onDone={() => setEditingId(null)} />
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span aria-hidden>🚗</span>
                  <input
                    value={v.name}
                    onChange={(e) => renameLocal(v.id, { name: e.target.value })}
                    onBlur={(e) => void renameVehicle(v.id, e.target.value.trim() || v.id)}
                    aria-label={`Rename ${v.name}`}
                    className="w-full bg-transparent font-medium outline-none"
                  />
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {v.brand ? `${v.brand} · ` : ""}
                  {v.hasTelemetry
                    ? `SoC ${Math.round(v.soc)}% · ${Math.round(v.rangeKm)} km · ${v.batteryKwh} kWh`
                    : "Manual — no app; select it by hand, plans target kWh only"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <button
                  onClick={() => setEditingId(v.id)}
                  aria-label={`Edit ${v.name} credentials`}
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
