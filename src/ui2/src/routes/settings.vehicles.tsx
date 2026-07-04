import { createFileRoute } from "@tanstack/react-router";
import { useOsc, type Vehicle } from "@/lib/mock/store";
import { Trash2, Undo2, Check } from "lucide-react";
import { useRef, useState } from "react";

export const Route = createFileRoute("/settings/vehicles")({ component: VehiclesSettings });

function VehiclesSettings() {
  const vehicles = useOsc((s) => s.vehicles);
  const chargers = useOsc((s) => s.chargers);
  const add = useOsc((s) => s.addVehicle);
  const remove = useOsc((s) => s.removeVehicle);
  const restore = useOsc((s) => s.restoreVehicle);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [justAdded, setJustAdded] = useState(false);
  const [undo, setUndo] = useState<{ vehicle: Vehicle; chargerIds: string[] } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const removeVehicle = (v: Vehicle) => {
    const chargerIds = chargers.filter((c) => c.activeVehicleId === v.id).map((c) => c.id);
    remove(v.id);
    setUndo({ vehicle: v, chargerIds });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
  };
  const undoRemove = () => {
    if (!undo) return;
    restore(undo.vehicle, undo.chargerIds);
    setUndo(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
  };
  const connect = () => {
    add({ name: "Enyaq", brand: "Škoda", soc: 55, rangeKm: 280, batteryKwh: 77, connected: true });
    setEmail("");
    setPw("");
    setJustAdded(true);
    if (addedTimer.current) clearTimeout(addedTimer.current);
    addedTimer.current = setTimeout(() => setJustAdded(false), 1800);
  };

  return (
    <div className="space-y-4">
      {undo && (
        <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-secondary px-4 py-3 text-sm">
          <span>
            Removed{" "}
            <span className="font-medium">
              {undo.vehicle.brand} {undo.vehicle.name}
            </span>
          </span>
          <button
            onClick={undoRemove}
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            <Undo2 className="h-3.5 w-3.5" /> Undo
          </button>
        </div>
      )}

      {vehicles.map((v) => (
        <div
          key={v.id}
          className="flex items-center justify-between rounded-2xl border border-border/60 bg-card p-4"
        >
          <div>
            <div className="font-medium">
              🚗 {v.brand} {v.name}
            </div>
            <div className="text-xs text-muted-foreground">
              SoC {Math.round(v.soc)}% · {Math.round(v.rangeKm)} km · {v.batteryKwh} kWh
            </div>
          </div>
          <button
            onClick={() => removeVehicle(v)}
            aria-label={`Remove ${v.brand} ${v.name}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}

      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="mb-2 font-medium">Connect a Škoda / VW</div>
        <div className="space-y-2">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
          <input
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="password"
            type="password"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={connect}
          disabled={justAdded}
          className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-70"
        >
          {justAdded ? (
            <>
              <Check className="h-4 w-4" /> Connected
            </>
          ) : (
            "Connect"
          )}
        </button>
        <div className="mt-2 text-[11px] text-muted-foreground">
          Any credentials work — this is a mock.
        </div>
      </div>
    </div>
  );
}
