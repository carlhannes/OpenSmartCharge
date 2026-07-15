import {
  createFileRoute,
  useNavigate,
  useRouter,
  useCanGoBack,
  Link,
} from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import {
  addPlan as addPlanCmd,
  updatePlan as updatePlanCmd,
  setTimezone,
} from "@/lib/live/commands";
import { REGIONS } from "@/lib/copy";
import { ConfigLockNote } from "@/components/settings/ConfigLockNote";
import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";

const STEPS = ["welcome", "charger", "region", "house", "car", "plan"] as const;
type Step = (typeof STEPS)[number];

export const Route = createFileRoute("/onboarding/$step")({
  // `add` marks the focused "add another charger" entry from Settings (vs the first-run wizard).
  validateSearch: (s: Record<string, unknown>): { add?: boolean } => ({
    add: s.add === true || s.add === "true",
  }),
  component: OnboardingStep,
});

function OnboardingStep() {
  const { step } = Route.useParams() as { step: Step };
  const { add } = Route.useSearch();
  const nav = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const idx = STEPS.indexOf(step);

  // Back returns to wherever the user actually came from (Settings / Home / previous step) rather
  // than walking the fixed STEPS array — which used to dump mid-flow entrants onto the Welcome page.
  const goBack = () => {
    if (canGoBack) router.history.back();
    else if (add) nav({ to: "/settings/chargers" });
    else if (idx > 0) nav({ to: "/onboarding/$step", params: { step: STEPS[idx - 1] } });
    else nav({ to: "/" });
  };
  const next = () => {
    if (idx < STEPS.length - 1) nav({ to: "/onboarding/$step", params: { step: STEPS[idx + 1] } });
    else {
      // Setup done → persist the browser's timezone as the site timezone (PUT when live).
      void setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
      useOsc.getState().finishOnboarding();
      nav({ to: "/" });
    }
  };

  // Focused "add another charger" mode (entered from Settings): just the charger step, no first-run
  // wizard and no Finish — "Done" returns to Settings without re-running setup / resetting timezone.
  if (add) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg flex-col px-5 py-8">
        <div className="flex-1">
          <ChargerStep addMode />
        </div>
        <div className="mt-8 flex items-center justify-between gap-3">
          <button
            onClick={goBack}
            className="rounded-full px-4 py-2.5 text-sm font-medium text-muted-foreground"
          >
            Back
          </button>
          <button
            onClick={() => nav({ to: "/settings/chargers" })}
            className="rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col px-5 py-8">
      {/* progress */}
      <div className="mb-8 flex gap-1.5">
        {STEPS.map((_, i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-full ${i <= idx ? "bg-primary" : "bg-secondary"}`}
          />
        ))}
      </div>

      <div className="flex-1">
        {step === "welcome" && <Welcome />}
        {step === "charger" && <ChargerStep />}
        {step === "region" && <RegionStep />}
        {step === "house" && <HouseStep />}
        {step === "car" && <CarStep />}
        {step === "plan" && <PlanStep />}
      </div>

      <div className="mt-8 flex items-center justify-between gap-3">
        <button
          onClick={goBack}
          disabled={idx === 0 && !canGoBack}
          className="rounded-full px-4 py-2.5 text-sm font-medium text-muted-foreground disabled:opacity-40"
        >
          Back
        </button>
        <div className="flex gap-2">
          {idx > 0 && idx < STEPS.length - 1 && (
            <button
              onClick={next}
              className="rounded-full px-4 py-2.5 text-sm font-medium text-muted-foreground"
            >
              Skip
            </button>
          )}
          <button
            onClick={next}
            className="rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {idx === STEPS.length - 1 ? "Finish" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StepShell({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        {eyebrow}
      </div>
      <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight md:text-4xl">
        {title}
      </h1>
      <div className="mt-6">{children}</div>
    </>
  );
}

function Welcome() {
  return (
    <StepShell eyebrow="Welcome" title="Let's get your car charging smart.">
      <p className="text-sm text-muted-foreground">
        Six short steps. We'll connect your charger, pick your electricity zone, tell OSC about your
        house, and set your first plan. You can skip anything and finish later from Settings.
      </p>
      <div className="mt-6 space-y-2 text-sm">
        {[
          "Connect a charger",
          "Pick your price zone",
          "Tell us about your house",
          "Add your car",
          "Set a plan",
        ].map((t, i) => (
          <div key={t} className="flex items-center gap-3 rounded-xl bg-secondary/60 p-3">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-background text-xs font-medium">
              {i + 1}
            </span>
            {t}
          </div>
        ))}
      </div>
    </StepShell>
  );
}

function ChargerStep({ addMode }: { addMode?: boolean }) {
  const emit = useOsc((s) => s.emitPending);
  const pending = useOsc((s) => s.pendingChargers);
  const claim = useOsc((s) => s.claimPending);
  // Against a live backend, chargers are paired in osc.yaml — this flow is a preview (no write API).
  const locked = useOsc((s) => s.source === "live");
  const [copied, setCopied] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [name, setName] = useState("Garage");
  const [amps, setAmps] = useState(16);
  const url = "ws://osc.local:8080/ocpp/garage";

  useEffect(() => {
    if (pending.length === 0 && !claimed) {
      const t = setTimeout(() => emit(), 3500);
      return () => clearTimeout(t);
    }
  }, [pending.length, claimed, emit]);

  const detected = pending[0];

  return (
    <StepShell eyebrow={addMode ? "Add charger" : "Step 1"} title="Connect your charger">
      {locked && (
        <ConfigLockNote>
          New chargers are paired in your config file (osc.yaml) — this is a preview.
        </ConfigLockNote>
      )}
      <p className="text-sm text-muted-foreground">Point your OCPP 1.6J charger at this address:</p>
      <div className="mt-3 flex items-center gap-2 rounded-2xl border border-border/60 bg-card p-3">
        <code className="flex-1 truncate font-mono text-sm">{url}</code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1.5 text-xs font-medium"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{" "}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="mt-6">
        {claimed ? (
          <div className="rounded-2xl border border-primary/40 bg-primary/5 p-5 text-sm font-medium text-primary">
            <span className="inline-flex items-center gap-1.5">
              <Check className="h-4 w-4" /> Charger added — {name} is connected.
            </span>
          </div>
        ) : !detected ? (
          <div className="flex items-center gap-3 rounded-2xl border border-dashed p-5 text-sm text-muted-foreground">
            <span className="h-2 w-2 animate-pulse rounded-full bg-status-warn" />
            Waiting for charger to connect…
          </div>
        ) : (
          <div className="rounded-2xl border border-primary/40 bg-primary/5 p-5">
            <div className="text-sm font-medium text-primary">
              ✓ Detected <span className="font-mono">{detected.stationId}</span>
            </div>
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs uppercase tracking-widest text-muted-foreground">
                  Name it
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs uppercase tracking-widest text-muted-foreground">
                  Max amps
                </label>
                <input
                  type="number"
                  min={6}
                  max={32}
                  value={amps}
                  onChange={(e) => setAmps(parseInt(e.target.value, 10) || 0)}
                  className="w-24 rounded-lg border border-input bg-background px-3 py-2 text-sm tabular-nums"
                />
              </div>
              <button
                onClick={() => {
                  claim(detected.id, name, amps);
                  setClaimed(true);
                }}
                className="w-full rounded-full bg-primary py-2.5 text-sm font-medium text-primary-foreground"
              >
                Claim this charger
              </button>
            </div>
          </div>
        )}
      </div>
    </StepShell>
  );
}

function RegionStep() {
  const region = useOsc((s) => s.config.region);
  const setConfig = useOsc((s) => s.setConfig);
  return (
    <StepShell eyebrow="Step 2" title="Your electricity zone">
      <p className="text-sm text-muted-foreground">This picks the day-ahead price feed.</p>
      <div className="mt-4 space-y-2">
        {REGIONS.map((r) => (
          <button
            key={r.id}
            onClick={() => setConfig({ region: r.id })}
            className={`flex w-full items-center justify-between rounded-2xl border p-4 text-left transition ${
              region === r.id ? "border-primary bg-primary/5" : "border-border/60 bg-card"
            }`}
          >
            <span className="text-sm font-medium">{r.label}</span>
            {region === r.id && <span className="text-primary">✓</span>}
          </button>
        ))}
      </div>
    </StepShell>
  );
}

function HouseStep() {
  const c = useOsc((s) => s.config);
  const setConfig = useOsc((s) => s.setConfig);
  return (
    <StepShell eyebrow="Step 3" title="Your house">
      <label className="mb-1 block text-xs uppercase tracking-widest text-muted-foreground">
        Main breaker size
      </label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={6}
          max={200}
          value={c.breakerAmps}
          onChange={(e) => setConfig({ breakerAmps: parseInt(e.target.value, 10) || 0 })}
          className="w-28 rounded-lg border border-input bg-background px-3 py-2 tabular-nums"
        />
        <span className="text-sm text-muted-foreground">A</span>
      </div>
      <div className="mt-6 space-y-2">
        {[
          { id: "tibber", label: "Tibber Pulse", desc: "Live per-phase currents." },
          { id: "mqtt", label: "MQTT meter", desc: "DSMR / OBIS bridge." },
          { id: "static", label: "Safe static limit", desc: "No live meter needed." },
        ].map((o) => (
          <button
            key={o.id}
            onClick={() => setConfig({ balancerMode: o.id as never })}
            className={`flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition ${
              c.balancerMode === o.id ? "border-primary bg-primary/5" : "border-border/60 bg-card"
            }`}
          >
            <div className="flex-1">
              <div className="text-sm font-medium">{o.label}</div>
              <div className="text-xs text-muted-foreground">{o.desc}</div>
            </div>
            {c.balancerMode === o.id && <span className="text-primary">✓</span>}
          </button>
        ))}
      </div>
    </StepShell>
  );
}

function CarStep() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [added, setAdded] = useState(false);
  const add = useOsc((s) => s.addVehicle);
  return (
    <StepShell eyebrow="Step 4 · optional" title="Add your car">
      <p className="text-sm text-muted-foreground">
        Sign in to Škoda / VW for live SoC, or skip and use a Guest profile.
      </p>
      <div className="mt-4 rounded-2xl border border-border/60 bg-card p-4">
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
          className="mt-2 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
        />
        <button
          onClick={() => {
            add({
              name: "Enyaq",
              brand: "Škoda",
              soc: 55,
              rangeKm: 280,
              batteryKwh: 77,
              connected: true,
              targetUnits: ["pct", "km", "kwh"],
              hasTelemetry: true,
            });
            setAdded(true);
          }}
          disabled={added}
          className="mt-3 w-full rounded-full bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {added ? "✓ Connected" : "Connect"}
        </button>
      </div>
    </StepShell>
  );
}

function PlanStep() {
  const chargers = useOsc((s) => s.chargers);
  const plans = useOsc((s) => s.plans);
  const [chargerId] = useState(chargers[0]?.id);
  const existing = plans.find((p) => p.chargerId === chargerId && p.enabled);

  useEffect(() => {
    if (chargerId && !existing) void addPlanCmd(chargerId);
  }, [chargerId, existing]);

  const plan = plans.find((p) => p.chargerId === chargerId);

  return (
    <StepShell eyebrow="Step 5" title="Your first plan">
      <p className="text-sm text-muted-foreground">
        Weekdays, ready by 07:00, at 80%. Tweak it or leave the default.
      </p>
      {plan && (
        <div className="mt-6 rounded-2xl border border-border/60 bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Ready by</span>
            <input
              type="time"
              value={plan.readyBy}
              onChange={(e) => void updatePlanCmd(plan.id, { readyBy: e.target.value })}
              className="rounded-lg border border-input bg-background px-2 py-1 text-sm tabular-nums"
            />
          </div>
          <div className="mt-4 flex items-center justify-between">
            <span className="text-sm font-medium">Target %</span>
            <input
              type="number"
              value={plan.target}
              onChange={(e) =>
                void updatePlanCmd(plan.id, {
                  target: parseFloat(e.target.value) || 0,
                  unit: "pct",
                })
              }
              className="w-20 rounded-lg border border-input bg-background px-2 py-1 text-sm tabular-nums"
            />
          </div>
        </div>
      )}
      <Link to="/" className="mt-6 block text-center text-xs text-muted-foreground hover:underline">
        Skip to home
      </Link>
    </StepShell>
  );
}
