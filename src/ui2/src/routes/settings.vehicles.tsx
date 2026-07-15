import { createFileRoute } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { addVehicle, removeVehicle } from "@/lib/live/commands";
import { Trash2, Check } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/settings/vehicles")({ component: VehiclesSettings });

function VehiclesSettings() {
  const vehicles = useOsc((s) => s.vehicles);
  const [kind, setKind] = useState<"skoda" | "manual">("skoda");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [vin, setVin] = useState("");
  const [busy, setBusy] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    kind === "manual"
      ? name.trim().length > 0
      : !!(name.trim() && email.trim() && pw && vin.trim().length === 17);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await addVehicle(
        kind === "manual"
          ? { name: name.trim(), type: "manual" }
          : {
              name: name.trim(),
              type: "skoda",
              username: email.trim(),
              password: pw,
              vin: vin.trim(),
            },
      );
      setName("");
      setEmail("");
      setPw("");
      setVin("");
      setJustAdded(true);
      setTimeout(() => setJustAdded(false), 1800);
    } catch (e) {
      setError((e as Error).message ?? "Failed to add vehicle");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {vehicles.map((v) => (
        <div
          key={v.id}
          className="flex items-center justify-between rounded-2xl border border-border/60 bg-card p-4"
        >
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
          <button
            onClick={() => void removeVehicle(v.id)}
            aria-label={`Remove ${v.name}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}

      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="mb-3 font-medium">Add a vehicle</div>
        <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-secondary p-1 text-sm">
          {(["skoda", "manual"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${
                kind === k ? "bg-background shadow-sm" : "text-muted-foreground"
              }`}
            >
              {k === "skoda" ? "Škoda / VW (app)" : "Manual (no app)"}
            </button>
          ))}
        </div>
        <div className="space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === "manual" ? "Name (e.g. Opel eVivaro)" : "Name (e.g. Enyaq)"}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          />
          {kind === "skoda" && (
            <>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="MySkoda email"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
              />
              <input
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="password"
                type="password"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
              />
              <input
                value={vin}
                onChange={(e) => setVin(e.target.value.toUpperCase())}
                placeholder="VIN (17 characters)"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm tabular-nums outline-none focus:ring-2 focus:ring-ring/40"
              />
            </>
          )}
        </div>
        <button
          onClick={() => void submit()}
          disabled={!canSubmit || busy || justAdded}
          className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {justAdded ? (
            <>
              <Check className="h-4 w-4" /> Added
            </>
          ) : busy ? (
            "Adding…"
          ) : (
            "Add vehicle"
          )}
        </button>
        {error && <div className="mt-2 text-xs text-status-bad">{error}</div>}
        <div className="mt-2 text-[11px] text-muted-foreground">
          {kind === "manual"
            ? "No app connection — you pick it at the charger, and its plans can only target kWh."
            : "An app car is auto-detected on plug-in and can target %, km, or kWh."}
        </div>
      </div>
    </div>
  );
}
