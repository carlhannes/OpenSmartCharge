import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useOsc, type Vehicle } from "@/lib/mock/store";
import type { VehicleConfigFieldDto } from "@/lib/api/rest";
import { addVehicle, updateVehicle } from "@/lib/live/commands";

const inputClass =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40";

interface Props {
  mode: "create" | "edit";
  /** The vehicle being edited (edit mode) — pre-fills the type + what the store knows (name, vin). */
  existing?: Vehicle;
  /** Called after a successful submit (e.g. to close an edit panel). */
  onDone?: () => void;
}

/**
 * The one create/edit/onboarding vehicle form. It renders entirely from the backend-declared vehicle
 * types (store `vehicleTypes`, seeded in demo / fetched live): a type picker + the universal `name`,
 * then the selected type's `configFields`. A new car module appears here with no change to this file.
 * Name + type are immutable on edit; a blank field on edit keeps the stored value (creds are
 * write-only, so they show blank with a "leave blank to keep" hint).
 */
export function VehicleForm({ mode, existing, onDone }: Props) {
  const types = useOsc((s) => s.vehicleTypes);
  const isEdit = mode === "edit";

  const [type, setType] = useState(existing?.type ?? types[0]?.type ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(() => types.find((t) => t.type === type), [types, type]);

  // Re-seed the field values only when the selected type or the edited vehicle *identity* changes —
  // NOT on every `existing` object churn (a live SSE poll patching the same car mustn't wipe an
  // in-progress edit). Pre-fills any field the store already knows for this vehicle (currently vin).
  useEffect(() => {
    const init: Record<string, string> = {};
    for (const f of selected?.fields ?? []) {
      const known = (existing as unknown as Record<string, unknown> | undefined)?.[f.key];
      init[f.key] = isEdit && typeof known === "string" ? known : "";
    }
    setFields(init);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, existing?.id]);

  // Per-field validation, mirroring the backend descriptor rules. On edit a blank field is allowed
  // (keeps the stored value); a provided value must still match the field's pattern.
  const fieldError = (f: VehicleConfigFieldDto, raw: string): string | null => {
    const v = raw.trim();
    if (!v) return !isEdit && f.required ? `${f.label} is required` : null;
    if (f.pattern && !new RegExp(f.pattern).test(v)) return `${f.label} is invalid`;
    return null;
  };

  const invalid =
    (!isEdit && !name.trim()) ||
    (selected?.fields ?? []).some((f) => fieldError(f, fields[f.key] ?? "") != null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // Send only non-blank fields (trimmed); on create that's every required field, on edit it's the
      // subset the user actually changed (blank = keep).
      const payload: Record<string, string> = {};
      for (const f of selected?.fields ?? []) {
        const v = (fields[f.key] ?? "").trim();
        if (v) payload[f.key] = v;
      }
      if (isEdit && existing) {
        await updateVehicle(existing.id, payload);
      } else {
        await addVehicle({ name: name.trim(), type, fields: payload });
        setName("");
        setFields((prev) => Object.fromEntries(Object.keys(prev).map((k) => [k, ""])));
      }
      setDone(true);
      setTimeout(() => setDone(false), 1800);
      onDone?.();
    } catch (e) {
      setError((e as Error).message ?? "Failed to save vehicle");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {isEdit ? (
        <div className="text-sm">
          <span className="font-medium">Editing {existing?.name}</span>
          <span className="text-muted-foreground"> · {selected?.label ?? existing?.type}</span>
        </div>
      ) : (
        <>
          <div className="font-medium">Add a vehicle</div>
          {/* Type picker — one pill per registered type (locked to a single choice once created). */}
          <div
            className="grid gap-1 rounded-xl bg-secondary p-1 text-sm"
            style={{ gridTemplateColumns: `repeat(${Math.max(types.length, 1)}, minmax(0, 1fr))` }}
          >
            {types.map((t) => (
              <button
                key={t.type}
                onClick={() => setType(t.type)}
                className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${
                  type === t.type ? "bg-background shadow-sm" : "text-muted-foreground"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. Enyaq)"
            className={inputClass}
          />
        </>
      )}

      {(selected?.fields ?? []).map((f) => {
        const err = fieldError(f, fields[f.key] ?? "");
        return (
          <div key={f.key}>
            <input
              value={fields[f.key] ?? ""}
              onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
              type={f.type ?? "text"}
              placeholder={isEdit && f.secret ? `${f.label} — leave blank to keep` : f.label}
              className={inputClass}
            />
            {f.help && !err && (
              <div className="mt-1 text-[11px] text-muted-foreground">{f.help}</div>
            )}
            {err && fields[f.key] && <div className="mt-1 text-[11px] text-status-bad">{err}</div>}
          </div>
        );
      })}

      <button
        onClick={() => void submit()}
        disabled={invalid || busy || done}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {done ? (
          <>
            <Check className="h-4 w-4" /> Saved
          </>
        ) : busy ? (
          "Saving…"
        ) : isEdit ? (
          "Save changes"
        ) : (
          "Add vehicle"
        )}
      </button>

      {error && <div className="text-xs text-status-bad">{error}</div>}

      {!isEdit && selected && (
        <div className="text-[11px] text-muted-foreground">
          {selected.capabilities.soc
            ? "An app car is auto-detected on plug-in and can target %, km, or kWh."
            : "No app connection — you pick it at the charger, and its plans can only target kWh."}
        </div>
      )}
    </div>
  );
}
