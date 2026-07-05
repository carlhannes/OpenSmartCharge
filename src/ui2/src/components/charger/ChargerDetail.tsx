import { useOsc, type Mode } from "@/lib/mock/store";
import type { Charger } from "@/lib/mock/store";
import {
  changeMode,
  applyOneShot,
  runCommand as runCmdApi,
  viewComposite,
  addPlan as addPlanCmd,
  updatePlan as updatePlanCmd,
  removePlan as removePlanCmd,
  setMinSoc,
} from "@/lib/live/commands";
import { Timeline24h } from "./Timeline24h";
import { StatusPill } from "@/components/StatusPill";
import { modeLabel } from "@/lib/copy";
import { fmtKW, fmtPct, fmtKm, DAYS, DAY_KEYS, type DayKey } from "@/lib/format";
import { resolveActivePlan } from "@/lib/plan";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { ActionButton } from "@/components/ui/action-button";
import { InlineStatus } from "@/components/ui/inline-status";
import { Trash2, Plus, ChevronDown, Sparkles, Zap, Power } from "lucide-react";
import { useState, useMemo, useRef } from "react";

interface Props {
  charger: Charger | null;
  onClose: () => void;
}

const MODE_ICONS = { off: Power, smart: Sparkles, fast: Zap };

export function ChargerDetail({ charger, onClose }: Props) {
  const vehicles = useOsc((s) => s.vehicles);
  const allPlans = useOsc((s) => s.plans);
  const plans = useMemo(
    () => allPlans.filter((p) => p.chargerId === charger?.id),
    [allPlans, charger?.id],
  );
  const setActiveVehicle = useOsc((s) => s.setActiveVehicle);
  const setGuestTarget = useOsc((s) => s.setGuestTarget);
  const oneShotAmps = useOsc((s) => s.oneShotAmps);
  const timezone = useOsc((s) => s.timezone);
  const [advOpen, setAdvOpen] = useState(false);
  const [amps, setAmps] = useState(charger?.constraintAmps ?? charger?.maxAmps ?? 16);
  const [minSocVal, setMinSocVal] = useState(charger?.minSoc ?? 20);
  const [ampApplied, setAmpApplied] = useState(false);
  const [lastCmd, setLastCmd] = useState<string | null>(null);
  const [showComposite, setShowComposite] = useState(false);
  const [compositeText, setCompositeText] = useState<string | null>(null);
  const ampTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!charger) return null;

  const commitAmps = () => {
    void applyOneShot(charger.id, amps);
    setAmpApplied(true);
    if (ampTimer.current) clearTimeout(ampTimer.current);
    ampTimer.current = setTimeout(() => setAmpApplied(false), 1500);
  };
  const commitMinSoc = () => void setMinSoc(charger.id, minSocVal);
  const runCommand = async (label: string) => {
    await runCmdApi(charger.id, label); // real OCPP endpoint when live; simulated delay in demo
    setLastCmd(label);
  };

  const vehicle = vehicles.find((v) => v.id === charger.activeVehicleId) ?? null;
  const nextReady = resolveActivePlan(plans, timezone)?.readyBy;
  const readyByHour = nextReady ? parseInt(nextReady.split(":")[0], 10) : undefined;

  return (
    <Sheet open={!!charger} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="bottom"
        className="max-h-[92vh] overflow-y-auto rounded-t-3xl border-none bg-background p-0 md:right-4 md:top-4 md:bottom-4 md:h-auto md:max-h-none md:w-[520px] md:rounded-3xl md:border md:border-border"
      >
        <SheetTitle className="sr-only">{charger.name}</SheetTitle>

        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border md:hidden" />

        <div className="px-5 pt-4 pb-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Charger</div>
              <h2 className="mt-1 font-display text-2xl font-semibold">{charger.name}</h2>
            </div>
            <StatusPill status={charger.status} />
          </div>

          {/* Mode switch */}
          <div className="mb-5 grid grid-cols-3 gap-1 rounded-2xl bg-secondary p-1">
            {(["off", "smart", "fast"] as Mode[]).map((m) => {
              const Icon = MODE_ICONS[m];
              const active = charger.mode === m;
              return (
                <button
                  key={m}
                  onClick={() => void changeMode(charger.id, m)}
                  className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {modeLabel[m]}
                </button>
              );
            })}
          </div>

          <Timeline24h readyByHour={readyByHour} />

          {/* Vehicle */}
          <div className="mt-5 rounded-2xl border border-border/60 bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                Vehicle
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setActiveVehicle(charger.id, null)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  !vehicle
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-secondary-foreground"
                }`}
              >
                Guest
              </button>
              {vehicles.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setActiveVehicle(charger.id, v.id)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                    vehicle?.id === v.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-secondary-foreground"
                  }`}
                >
                  🚗 {v.name}
                </button>
              ))}
            </div>
            {vehicle ? (
              <>
                <div className="mt-3 flex items-baseline justify-between">
                  <div className="font-display text-3xl font-semibold">{fmtPct(vehicle.soc)}</div>
                  <div className="text-sm text-muted-foreground">
                    {fmtKm(vehicle.rangeKm)} range · {fmtKW(charger.currentPowerW)}
                  </div>
                </div>
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-xs text-muted-foreground">Keep charged above</label>
                    <span className="tabular-nums text-xs">{minSocVal}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={minSocVal}
                    onChange={(e) => setMinSocVal(parseInt(e.target.value, 10))}
                    onMouseUp={commitMinSoc}
                    onTouchEnd={commitMinSoc}
                    className="w-full accent-primary"
                  />
                </div>
              </>
            ) : (
              <div className="mt-3">
                <label className="mb-1 block text-xs text-muted-foreground">
                  Target for this session (kWh)
                </label>
                <input
                  type="number"
                  min={0}
                  value={charger.guestTargetKwh ?? ""}
                  onChange={(e) =>
                    setGuestTarget(charger.id, e.target.value ? parseFloat(e.target.value) : null)
                  }
                  placeholder="Just charge"
                  className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
                />
              </div>
            )}
          </div>

          {/* Plans */}
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                Plans
              </h3>
              <button
                onClick={() => void addPlanCmd(charger.id)}
                className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Plus className="h-3.5 w-3.5" /> Add plan
              </button>
            </div>
            <div className="space-y-3">
              {plans.length === 0 && (
                <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  No plans — I'll just charge when plugged in.
                </div>
              )}
              {plans.map((p) => (
                <PlanRow key={p.id} planId={p.id} availableUnits={charger.availableTargetUnits} />
              ))}
            </div>
          </div>

          {/* Advanced */}
          <button
            onClick={() => setAdvOpen((x) => !x)}
            className="mt-6 flex w-full items-center justify-between rounded-2xl bg-secondary px-4 py-3 text-sm font-medium"
          >
            <span>Advanced</span>
            <ChevronDown className={`h-4 w-4 transition ${advOpen ? "rotate-180" : ""}`} />
          </button>
          {advOpen && (
            <div className="mt-3 space-y-3 rounded-2xl border border-border/60 bg-card p-4 text-sm">
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">
                    One-shot amp limit
                  </label>
                  <span className="tabular-nums text-xs">
                    {amps} A {ampApplied && <span className="text-status-ok">· applied ✓</span>}
                  </span>
                </div>
                <input
                  type="range"
                  min={6}
                  max={32}
                  value={amps}
                  onChange={(e) => setAmps(parseInt(e.target.value, 10))}
                  onMouseUp={commitAmps}
                  onTouchEnd={commitAmps}
                  className="w-full accent-primary"
                />
                {charger.constraintAmps != null && (
                  <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-secondary px-3 py-2 text-xs">
                    <span>
                      Active limit:{" "}
                      <span className="font-medium tabular-nums">{charger.constraintAmps} A</span>
                      <span className="text-muted-foreground"> · shown on the charger card</span>
                    </span>
                    <button
                      onClick={() => oneShotAmps(charger.id, null)}
                      className="shrink-0 font-medium text-primary hover:underline"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {["Start", "Stop", "Soft reset", "Hard reset", "Clear profile"].map((a) => (
                  <ActionButton
                    key={a}
                    onRun={() => runCommand(a)}
                    successLabel="Sent"
                    className="rounded-xl border border-border/60 bg-background px-3 py-2 text-xs font-medium hover:bg-secondary"
                  >
                    {a}
                  </ActionButton>
                ))}
                <button
                  onClick={() => {
                    const open = !showComposite;
                    setShowComposite(open);
                    if (open) {
                      setCompositeText(null);
                      void viewComposite(charger.id)
                        .then(setCompositeText)
                        .catch(() => setCompositeText("Unavailable"));
                    }
                  }}
                  className="rounded-xl border border-border/60 bg-background px-3 py-2 text-xs font-medium hover:bg-secondary"
                >
                  View composite
                </button>
              </div>
              {lastCmd && (
                <InlineStatus state="success">Last command: {lastCmd} · sent</InlineStatus>
              )}
              {showComposite && (
                <div className="rounded-xl border border-border/60 bg-background p-3 text-xs">
                  <div className="mb-1 font-medium">Composite schedule</div>
                  {compositeText == null ? (
                    <div className="text-muted-foreground">Loading…</div>
                  ) : (
                    <pre className="overflow-x-auto whitespace-pre-wrap tabular-nums text-muted-foreground">
                      {compositeText}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PlanRow({
  planId,
  availableUnits,
}: {
  planId: string;
  availableUnits: Charger["availableTargetUnits"];
}) {
  const plan = useOsc((s) => s.plans.find((p) => p.id === planId)!);
  if (!plan) return null;

  const toggleDay = (d: DayKey) => {
    const set = new Set(plan.days);
    if (set.has(d)) set.delete(d);
    else set.add(d);
    void updatePlanCmd(plan.id, { days: Array.from(set) });
  };

  // Units the picker offers: what the loadpoint's data can back now, plus the plan's current unit
  // (so the active selection is never hidden). The backend computes resolvedSoc — never recomputed here.
  const units = (["pct", "km", "kwh"] as const).filter(
    (u) => availableUnits.includes(u) || u === plan.unit,
  );

  return (
    <div
      className={`rounded-2xl border border-border/60 bg-card p-4 ${plan.enabled ? "" : "opacity-60"}`}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Switch
            checked={plan.enabled}
            onCheckedChange={(v) => void updatePlanCmd(plan.id, { enabled: v })}
          />
          <span className="text-sm font-medium">Ready by</span>
          <input
            type="time"
            value={plan.readyBy}
            onChange={(e) => void updatePlanCmd(plan.id, { readyBy: e.target.value })}
            className="rounded-lg border border-input bg-background px-2 py-1 text-sm tabular-nums outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
        <button
          onClick={() => void removePlanCmd(plan.id)}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-3 flex gap-1">
        {DAY_KEYS.map((d, i) => {
          const active = plan.days.includes(d);
          return (
            <button
              key={d}
              onClick={() => toggleDay(d)}
              className={`grid h-8 flex-1 place-items-center rounded-lg text-xs font-medium transition ${
                active ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
              }`}
            >
              {DAYS[i]}
            </button>
          );
        })}
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="mb-1 block text-[11px] uppercase tracking-wider text-muted-foreground">
            Target
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              value={plan.target}
              onChange={(e) =>
                void updatePlanCmd(plan.id, { target: parseFloat(e.target.value) || 0 })
              }
              className="w-full rounded-lg border border-input bg-background px-2 py-1.5 text-sm tabular-nums outline-none focus:ring-2 focus:ring-ring/40"
            />
            <div className="flex rounded-lg bg-secondary p-0.5">
              {units.map((u) => (
                <button
                  key={u}
                  onClick={() => void updatePlanCmd(plan.id, { unit: u })}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium ${
                    plan.unit === u ? "bg-background shadow-sm" : "text-muted-foreground"
                  }`}
                >
                  {u === "pct" ? "%" : u}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      {plan.unit !== "pct" && plan.resolvedSoc != null && (
        <div className="mt-2 text-[11px] text-muted-foreground">≈ {plan.resolvedSoc}%</div>
      )}
      {plan.unit === "km" && plan.resolvedSoc == null && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          Needs a connected car to estimate %
        </div>
      )}
    </div>
  );
}
