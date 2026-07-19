import { useOsc, type Charger } from "@/lib/mock/store";
import { StatusPill } from "@/components/StatusPill";
import { fmtKW, fmtPct, fmtKWh, fmtKm } from "@/lib/format";
import { resolveActivePlan } from "@/lib/plan";

interface Props {
  charger: Charger;
  onOpen: () => void;
}

export function ChargerCard({ charger, onOpen }: Props) {
  const vehicle = useOsc((s) => s.vehicles.find((v) => v.id === charger.activeVehicleId));
  const plans = useOsc((s) => s.plans);
  const timezone = useOsc((s) => s.timezone);
  const plan = resolveActivePlan(
    plans.filter((p) => p.chargerId === charger.id),
    timezone,
    charger.activeVehicleId,
  );

  const soc = vehicle?.soc ?? 0;
  // Bound car: backend-resolved SoC target %. A guest has no SoC plan, so suppress the "of X%" arc/text
  // (showing the bound car's tomorrow-plan % while a guest charges is misleading) and instead fill the
  // ring by kWh delivered / the session's kWh target, when one is set.
  const targetPct = vehicle ? (plan?.resolvedSoc ?? null) : null;
  const guestFrac =
    !vehicle && charger.guestTargetKwh
      ? Math.min(charger.sessionKwh / charger.guestTargetKwh, 1)
      : null;

  const R = 44;
  const C = 2 * Math.PI * R;
  const primaryFrac = vehicle ? Math.min(soc, targetPct ?? 100) / 100 : (guestFrac ?? 0);
  const socOffset = C - primaryFrac * C;
  const targetOffset = targetPct != null ? C - (targetPct / 100) * C : C;

  return (
    <button
      onClick={onOpen}
      className="group w-full rounded-3xl border border-border/60 bg-card p-5 text-left shadow-sm transition hover:shadow-md active:scale-[0.995]"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Charger</div>
          <h3 className="mt-1 font-display text-xl font-semibold">{charger.name}</h3>
          <div className="mt-2">
            <StatusPill status={charger.status} />
          </div>
        </div>
        <div className="relative">
          <svg width="112" height="112" viewBox="0 0 112 112" className="-rotate-90">
            <circle
              cx="56"
              cy="56"
              r={R}
              fill="none"
              strokeWidth="6"
              className="stroke-secondary"
            />
            <circle
              cx="56"
              cy="56"
              r={R}
              fill="none"
              strokeWidth="6"
              className="stroke-accent/60"
              strokeDasharray={C}
              strokeDashoffset={targetOffset}
              strokeLinecap="round"
            />
            <circle
              cx="56"
              cy="56"
              r={R}
              fill="none"
              strokeWidth="6"
              className="stroke-primary transition-[stroke-dashoffset] duration-1000"
              strokeDasharray={C}
              strokeDashoffset={socOffset}
              strokeLinecap="round"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-display text-xl font-semibold tabular-nums">
              {vehicle ? fmtPct(vehicle.soc) : charger.sessionKwh.toFixed(1)}
            </span>
            {vehicle && vehicle.rangeKm > 0 && (
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {fmtKm(vehicle.rangeKm)}
              </span>
            )}
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {vehicle ? (targetPct != null ? `of ${targetPct}%` : " ") : "kWh charged"}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-4">
        <div className="text-sm">
          <span className="text-muted-foreground">Now </span>
          <span className="font-display tabular-nums">{fmtKW(charger.currentPowerW)}</span>
          {charger.sessionKwh > 0 && (
            <span className="text-muted-foreground">
              {" · "}
              <span className="tabular-nums text-foreground">
                {fmtKWh(charger.sessionKwh)}
              </span>{" "}
              charged
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {vehicle && <span>🚗 {vehicle.name}</span>}
          {!vehicle && <span>Guest</span>}
          {plan && (
            <span>
              · {plan.readyBy} · {plan.target}
              {plan.unit === "pct" ? "%" : plan.unit}
            </span>
          )}
        </div>
      </div>

      {charger.constraintAmps != null && (
        <div className="mt-3 rounded-xl bg-status-warn/10 px-3 py-2 text-xs text-status-warn">
          Limited to {charger.constraintAmps} A — house drawing power.
        </div>
      )}
    </button>
  );
}
