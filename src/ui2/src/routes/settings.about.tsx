import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { resetSystem } from "@/lib/live/commands";
import { waitForHealthy } from "@/lib/live/restart-flow";
import { useRef, useState } from "react";

export const Route = createFileRoute("/settings/about")({ component: AboutSettings });

function AboutSettings() {
  const setConfig = useOsc((s) => s.setConfig);
  const homeName = useOsc((s) => s.config.homeName);
  const isLive = useOsc((s) => s.source === "live");
  const nav = useNavigate();
  const [phase, setPhase] = useState<"idle" | "armed" | "resetting" | "timeout">("idle");
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const arm = () => {
    setPhase("armed");
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setPhase("idle"), 5000);
  };

  const doReset = async () => {
    if (armTimer.current) clearTimeout(armTimer.current);
    setPhase("resetting");
    try {
      await resetSystem(); // live: backend wipe + restart; demo: reset the mock store
    } catch {
      // the process may exit before the response lands — treat as fired
    }
    if (!isLive) {
      nav({ to: "/" }); // demo: the freshly-seeded store IS the feedback
      return;
    }
    const ok = await waitForHealthy();
    if (ok) window.location.reload();
    else setPhase("timeout");
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border/60 bg-card p-5">
        <div className="font-display text-xl font-semibold">OpenSmartCharge</div>
        <div className="mt-1 text-sm text-muted-foreground">
          v{__APP_VERSION__} · self-hosted smart charging
        </div>
        <p className="mt-3 text-sm">
          Lean, modular EV smart-charging. OCPP 1.6J on your LAN, day-ahead pricing, house load
          balancing, and a ready-when-you-leave promise.
        </p>
        {homeName && homeName !== "OpenSmartCharge" && (
          <p className="mt-3 text-sm text-muted-foreground">
            This installation: <span className="font-medium text-foreground">{homeName}</span>{" "}
            <span className="text-xs">(edit in Settings → House)</span>
          </p>
        )}
      </div>

      <button
        onClick={() => {
          setConfig({ isConfigured: false });
          nav({ to: "/onboarding/$step", params: { step: "welcome" } });
        }}
        className="w-full rounded-2xl border border-input bg-background py-3 text-sm font-medium"
      >
        Re-run onboarding
      </button>

      {/* DESTRUCTIVE reset. Live: a real backend wipe (config + plans + sessions + history) then a
          restart — the page reloads when OSC is back. Demo: reset the mock. Two-step confirm. */}
      <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4">
        <div className="mb-1 font-medium text-destructive">Reset all data</div>
        <p className="mb-3 text-xs text-muted-foreground">
          {isLive
            ? "Wipes ALL data on the server — config, chargers, vehicles, plans, sessions and history — then restarts. If you keep an osc.yaml your base config comes back on boot; otherwise OSC starts fresh at onboarding. This can't be undone."
            : "Resets this demo back to its seeded state (nothing is sent to a backend)."}
        </p>
        {phase === "resetting" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" /> Resetting… this
            page reloads when OSC is back.
          </div>
        ) : phase === "timeout" ? (
          <div className="text-sm text-status-warn">
            OSC hasn't come back yet. Under systemd/docker it should return shortly — reload this
            page. If you started it manually, start it again, then reload.
          </div>
        ) : phase === "armed" ? (
          <div className="flex gap-2">
            <button
              onClick={() => void doReset()}
              className="flex-1 rounded-2xl border border-destructive bg-destructive/10 py-3 text-sm font-semibold text-destructive"
            >
              Tap again to confirm — erase everything
            </button>
            <button
              onClick={() => setPhase("idle")}
              className="rounded-2xl border border-input bg-background px-4 py-3 text-sm font-medium"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={arm}
            className="w-full rounded-2xl py-3 text-sm font-medium text-destructive"
          >
            Reset all data
          </button>
        )}
      </div>
    </div>
  );
}
