// Day-aware active-plan resolution — mirrors the backend's charging rule so the UI
// summary matches what actually gets charged. Pure; timezone-aware via Intl.
import type { Plan } from "@/lib/mock/store";
import { DAY_KEYS, type DayKey } from "@/lib/format";

/** Current weekday key (mon..sun) in the given IANA timezone. */
function todayKey(timezone: string, now: Date): DayKey {
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone })
    .format(now)
    .toLowerCase()
    .slice(0, 3); // "Mon" → "mon", matches DAY_KEYS
  return (DAY_KEYS.find((k) => k === wd) ?? "mon") as DayKey;
}

/** "HH:MM" (24h) now in the given IANA timezone. */
function nowHHMM(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(now);
}

/** Does this plan apply to the loadpoint's active vehicle? Empty target set = any (catch-all); a null
 *  active vehicle (guest) matches the 'guest' sentinel. Mirrors backend core/plans.ts planApplies. */
export function planApplies(plan: Plan, activeVehicle: string | null): boolean {
  return plan.vehicles.length === 0 || plan.vehicles.includes(activeVehicle ?? "guest");
}

/**
 * The plan the backend would charge to right now: among ENABLED plans that APPLY to the active vehicle,
 * whose `days` include today (site timezone) with a `readyBy` still later today, the earliest `readyBy`
 * wins. Returns null if none qualify. Mirrors backend core/plans.ts selectActivePlan — keep in sync.
 */
export function resolveActivePlan(
  plans: Plan[],
  timezone: string,
  activeVehicle: string | null,
  now: Date = new Date(),
): Plan | null {
  const today = todayKey(timezone, now);
  const hhmm = nowHHMM(timezone, now);
  return (
    plans
      .filter(
        (p) =>
          p.enabled && planApplies(p, activeVehicle) && p.days.includes(today) && p.readyBy > hhmm,
      )
      .sort((a, b) => a.readyBy.localeCompare(b.readyBy))[0] ?? null
  );
}
