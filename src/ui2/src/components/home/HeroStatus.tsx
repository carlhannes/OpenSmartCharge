import { useOsc } from "@/lib/mock/store";
import { statusLabel } from "@/lib/copy";
import { resolveActivePlan } from "@/lib/plan";

export function HeroStatus() {
  const chargers = useOsc((s) => s.chargers);
  const plans = useOsc((s) => s.plans);
  const timezone = useOsc((s) => s.timezone);
  const primary = chargers[0];

  if (!primary) {
    return (
      <div className="px-5 pt-8 pb-4 md:pt-14 md:pb-8">
        <div className="font-display text-3xl font-semibold leading-tight">No chargers yet.</div>
        <p className="mt-1 text-sm text-muted-foreground">Add one from Settings to get started.</p>
      </div>
    );
  }

  const plan = resolveActivePlan(
    plans.filter((p) => p.chargerId === primary.id),
    timezone,
  );

  let headline = statusLabel(primary.status);
  let sub = "";
  if (primary.status === "charging")
    headline = `Charging${plan ? ` · ready by ${plan.readyBy}` : ""}`;
  else if (primary.status === "waiting_cheap") {
    headline = "Waiting for cheap power";
    sub = "Charging will start on the next low-price hour.";
  } else if (primary.status === "ready") {
    headline = "Ready to go";
    sub = "Target reached.";
  } else if (primary.status === "plugged_paused") sub = "Plug detected — waiting for a mode.";
  else if (primary.status === "off") sub = "This charger is turned off.";
  else if (primary.status === "fast_charging") headline = "Charging fast";

  return (
    <div className="px-5 pt-8 pb-2 md:pt-14 md:pb-6">
      <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        {new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
      </div>
      <h1 className="mt-2 font-display text-[clamp(1.9rem,5vw,2.75rem)] font-semibold leading-[1.05] tracking-tight">
        {headline}
        {primary.status === "ready" || primary.status === "charging" ? (
          <span className="text-status-ok"> ✓</span>
        ) : null}
      </h1>
      {sub && <p className="mt-2 max-w-md text-sm text-muted-foreground">{sub}</p>}
    </div>
  );
}
