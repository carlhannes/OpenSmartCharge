import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { useRef, useState } from "react";

export const Route = createFileRoute("/settings/about")({ component: AboutSettings });

function AboutSettings() {
  const reset = useOsc((s) => s.resetAll);
  const setConfig = useOsc((s) => s.setConfig);
  const nav = useNavigate();
  const [arming, setArming] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const arm = () => {
    setArming(true);
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArming(false), 4000);
  };
  const confirmReset = () => {
    if (armTimer.current) clearTimeout(armTimer.current);
    reset();
    // The fresh app is the feedback — land the user back on Home.
    nav({ to: "/" });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border/60 bg-card p-5">
        <div className="font-display text-xl font-semibold">OpenSmartCharge</div>
        <div className="mt-1 text-sm text-muted-foreground">
          v0.3.0 · self-hosted smart charging
        </div>
        <p className="mt-3 text-sm">
          Lean, modular EV smart-charging. OCPP 1.6J on your LAN, day-ahead pricing, house load
          balancing, and a ready-when-you-leave promise.
        </p>
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

      {!arming ? (
        <button
          onClick={arm}
          className="w-full rounded-2xl border border-destructive/40 bg-destructive/5 py-3 text-sm font-medium text-destructive"
        >
          Reset all data
        </button>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={confirmReset}
            className="flex-1 rounded-2xl border border-destructive bg-destructive/10 py-3 text-sm font-semibold text-destructive"
          >
            Tap again to confirm reset
          </button>
          <button
            onClick={() => setArming(false)}
            className="rounded-2xl border border-input bg-background px-4 py-3 text-sm font-medium"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
