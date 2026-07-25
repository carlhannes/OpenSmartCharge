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
  setRegion,
  setBreaker,
  claimCharger as claimChargerCmd,
  importBackup,
  restartSystem,
} from "@/lib/live/commands";
import * as api from "@/lib/api/rest";
import { waitForHealthy } from "@/lib/live/restart-flow";
import { copyText } from "@/lib/clipboard";
import { REGIONS } from "@/lib/copy";
import { VehicleForm } from "@/components/VehicleForm";
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
  const [showImport, setShowImport] = useState(false);
  return (
    <StepShell eyebrow="Welcome" title="Let's get your car charging smart.">
      <p className="text-sm text-muted-foreground">
        A few quick steps: we'll connect your charger, pick your electricity zone, tell OSC about
        your house, add your car, and set your first plan. You can skip anything and finish later
        from Settings.
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
      <div className="mt-6 border-t border-border/60 pt-5">
        <button
          onClick={() => setShowImport((v) => !v)}
          className="text-sm font-medium text-primary hover:underline"
        >
          …or import a backup instead
        </button>
        {showImport && <ImportPanel />}
      </div>
    </StepShell>
  );
}

// Import an exported osc.yaml backup, then restart to apply it (skipping the manual steps). Reuses
// POST /api/config/import (dry-run preview + real import) and the shared restart-then-reload flow.
function ImportPanel() {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "checking" | "importing" | "restarting" | "timeout">(
    "idle",
  );

  const onFile = (f: File | undefined) => {
    if (f) void f.text().then(setText);
  };

  const check = async () => {
    setErr(null);
    setPreview(null);
    setPhase("checking");
    try {
      const r = await importBackup(text, "merge", true);
      setPreview(r.sections);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPhase("idle");
    }
  };

  const importAndRestart = async () => {
    setErr(null);
    setPhase("importing");
    try {
      await importBackup(text, "merge", false);
    } catch (e) {
      setErr((e as Error).message);
      setPhase("idle");
      return;
    }
    useOsc.getState().finishOnboarding();
    setPhase("restarting");
    await restartSystem();
    const ok = await waitForHealthy();
    if (ok) window.location.assign("/");
    else setPhase("timeout");
  };

  if (phase === "restarting")
    return (
      <div className="mt-4 flex items-center gap-3 rounded-2xl border border-border/60 bg-card p-5 text-sm">
        <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
        Importing & restarting OSC… this page reloads automatically when it's back.
      </div>
    );
  if (phase === "timeout")
    return (
      <div className="mt-4 rounded-2xl border border-status-warn/40 bg-status-warn/10 p-5 text-sm text-status-warn">
        OSC hasn't come back yet. Under systemd/docker it should return shortly — reload this page.
        If you started it manually, start it again, then reload.
      </div>
    );

  return (
    <div className="mt-4 space-y-3 rounded-2xl border border-border/60 bg-card p-4">
      <p className="text-xs text-muted-foreground">
        Paste an <code>osc.yaml</code> backup (Settings → System → Export), or choose a file. It
        replaces the current config and applies on restart. Vehicle passwords are included only if
        the backup was exported with credentials.
      </p>
      <input
        type="file"
        accept=".yaml,.yml,text/yaml"
        onChange={(e) => onFile(e.target.files?.[0])}
        className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-full file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-xs file:font-medium"
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder={"site:\n  name: My Home\n…"}
        className="w-full rounded-lg border border-input bg-background p-2 font-mono text-xs"
      />
      {preview && (
        <div className="rounded-lg bg-secondary/60 p-2 text-xs">
          Looks valid — will import: {preview.join(", ")}
        </div>
      )}
      {err && <div className="text-xs text-status-bad">{err}</div>}
      <div className="flex gap-2">
        <button
          onClick={() => void check()}
          disabled={!text.trim() || phase === "checking"}
          className="rounded-full bg-secondary px-4 py-2 text-xs font-medium disabled:opacity-50"
        >
          {phase === "checking" ? "Checking…" : "Check"}
        </button>
        <button
          onClick={() => void importAndRestart()}
          disabled={!text.trim() || phase === "importing"}
          className="rounded-full bg-primary px-4 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {phase === "importing" ? "Importing…" : "Import & restart"}
        </button>
      </div>
    </div>
  );
}

function ChargerStep({ addMode }: { addMode?: boolean }) {
  const live = useOsc((s) => s.source === "live");
  // Demo store simulation (id-based) for offline/demo mode.
  const emit = useOsc((s) => s.emitPending);
  const demoPending = useOsc((s) => s.pendingChargers);
  const claimDemo = useOsc((s) => s.claimPending);
  // Live: poll the backend for connected-but-unclaimed OCPP stations.
  const [livePending, setLivePending] = useState<api.PendingChargerDto[]>([]);
  const [copied, setCopied] = useState(false);
  const [claimedName, setClaimedName] = useState<string | null>(null);
  const [name, setName] = useState("Garage");
  const [amps, setAmps] = useState(16);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const host = typeof window !== "undefined" ? window.location.host : "osc.local:8080";
  const url = `ws://${host}/ocpp/<your-charger-id>`;

  // Demo: surface a simulated pending station after a beat.
  useEffect(() => {
    if (live || claimedName) return;
    if (demoPending.length === 0) {
      const t = setTimeout(() => emit(), 2500);
      return () => clearTimeout(t);
    }
  }, [live, demoPending.length, claimedName, emit]);

  // Live: poll pending stations until one is claimed.
  useEffect(() => {
    if (!live || claimedName) return;
    let active = true;
    const tick = () =>
      api
        .getPendingChargers()
        .then((list) => active && setLivePending(list))
        .catch(() => {});
    void tick();
    const iv = setInterval(() => void tick(), 3000);
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, [live, claimedName]);

  const detected = live ? livePending[0] : demoPending[0];

  const doClaim = async () => {
    if (!detected) return;
    setErr(null);
    setBusy(true);
    try {
      if (live) {
        await claimChargerCmd({ stationId: detected.stationId, name, maxA: amps });
      } else {
        claimDemo((detected as { id: string }).id, name, amps);
      }
      setClaimedName(name);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepShell eyebrow={addMode ? "Add charger" : "Step 1"} title="Connect your charger">
      <p className="text-sm text-muted-foreground">
        In your charger's settings, point its OCPP 1.6J connection at this address — the last
        segment is your charger's own ID / serial:
      </p>
      <div className="mt-3 flex items-center gap-2 rounded-2xl border border-border/60 bg-card p-3">
        <code className="flex-1 truncate font-mono text-sm">{url}</code>
        <button
          onClick={() =>
            void copyText(url).then((ok) => {
              if (ok) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }
            })
          }
          className="inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1.5 text-xs font-medium"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{" "}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="mt-6">
        {claimedName ? (
          <div className="rounded-2xl border border-primary/40 bg-primary/5 p-5 text-sm font-medium text-primary">
            <span className="inline-flex items-center gap-1.5">
              <Check className="h-4 w-4" /> Charger added — {claimedName} is connected.
            </span>
          </div>
        ) : !detected ? (
          <div className="flex items-center gap-3 rounded-2xl border border-dashed p-5 text-sm text-muted-foreground">
            <span className="h-2 w-2 animate-pulse rounded-full bg-status-warn" />
            Waiting for a charger to connect…
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
              {err && <div className="text-xs text-status-bad">{err}</div>}
              <button
                onClick={() => void doClaim()}
                disabled={busy || !name.trim()}
                className="w-full rounded-full bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {busy ? "Claiming…" : "Claim this charger"}
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
  return (
    <StepShell eyebrow="Step 2" title="Your electricity zone">
      <p className="text-sm text-muted-foreground">This picks the day-ahead price feed.</p>
      <div className="mt-4 space-y-2">
        {REGIONS.map((r) => (
          <button
            key={r.id}
            onClick={() => void setRegion(r.id)}
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
  const breakerAmps = useOsc((s) => s.config.breakerAmps);
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
          value={breakerAmps}
          onChange={(e) => setConfig({ breakerAmps: parseInt(e.target.value, 10) || 0 })}
          onBlur={(e) => void setBreaker(parseInt(e.target.value, 10) || breakerAmps)}
          className="w-28 rounded-lg border border-input bg-background px-3 py-2 tabular-nums"
        />
        <span className="text-sm text-muted-foreground">A</span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        OSC never lets total draw exceed this. For live headroom — charging harder while the house
        is quiet — add a Tibber Pulse or MQTT meter later in Settings; otherwise it uses a safe
        static limit.
      </p>
    </StepShell>
  );
}

function CarStep() {
  return (
    <StepShell eyebrow="Step 4 · optional" title="Add your car">
      <p className="text-sm text-muted-foreground">
        Sign in to your car's app for live SoC, add a manual car, or skip and use a Guest profile.
      </p>
      <div className="mt-4 rounded-2xl border border-border/60 bg-card p-4">
        <VehicleForm mode="create" />
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
