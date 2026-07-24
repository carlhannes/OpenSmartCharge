import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { HeroStatus } from "@/components/home/HeroStatus";
import { HomePowerCard } from "@/components/home/HomePowerCard";
import { ChargerCard } from "@/components/home/ChargerCard";
import { ChargerDetail } from "@/components/charger/ChargerDetail";
import { useState, useMemo, useEffect } from "react";
import { AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const chargers = useOsc((s) => s.chargers);
  const source = useOsc((s) => s.source);
  const moduleHealth = useOsc((s) => s.moduleHealth);
  const nav = useNavigate();
  const degraded = useMemo(() => moduleHealth.filter((m) => m.status !== "ok"), [moduleHealth]);

  // First-run: a live backend with no chargers is a fresh install → send them to onboarding (where the
  // "import a backup" option also lives). Guarded by a short delay + a re-check of live store state so
  // the initial rehydrate (source flips to 'live' before /api/site finishes loading) can't trigger a
  // spurious redirect on a configured site.
  useEffect(() => {
    if (source !== "live") return;
    const t = setTimeout(() => {
      const s = useOsc.getState();
      if (s.source === "live" && s.chargers.length === 0) {
        void nav({ to: "/onboarding/$step", params: { step: "welcome" } });
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [source, chargers.length, nav]);

  // A degraded module that IS a charger link means charging is actually interrupted — don't claim
  // "charging continues". A degraded peripheral (prices / balancer / vehicle / MQTT) is different:
  // charging really does continue on the last-known plan. Correlate against the charger list (the
  // health key equals the charger/loadpoint id) rather than a hardcoded module name.
  const chargerDegraded = useMemo(
    () => degraded.filter((m) => chargers.some((c) => c.id === m.id)),
    [degraded, chargers],
  );
  const chargerDown = chargerDegraded.length > 0;
  const lead = chargerDown ? chargerDegraded[0] : degraded[0];
  const [openId, setOpenId] = useState<string | null>(null);
  const openCharger = chargers.find((c) => c.id === openId) ?? null;

  return (
    <div className="mx-auto max-w-2xl">
      <HeroStatus />

      <HomePowerCard />

      {lead && (
        <div
          className={`mx-5 mb-4 flex items-start gap-3 rounded-2xl p-4 text-sm ${
            chargerDown ? "bg-status-bad/10 text-status-bad" : "bg-status-warn/10 text-status-warn"
          }`}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">
              {chargerDown
                ? "Charger offline — not charging."
                : "Something's degraded — charging continues."}
            </div>
            <div className={`mt-0.5 ${chargerDown ? "text-status-bad/80" : "text-status-warn/80"}`}>
              {lead.message ||
                `${lead.name} — ${lead.status === "bad" ? "unavailable" : "degraded"}`}
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4 px-5 pb-8">
        {chargers.map((c) => (
          <ChargerCard key={c.id} charger={c} onOpen={() => setOpenId(c.id)} />
        ))}
        {chargers.length === 0 && (
          <Link
            to="/onboarding/$step"
            params={{ step: "welcome" }}
            className="block rounded-3xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground hover:bg-secondary/50"
          >
            + Connect your first charger
          </Link>
        )}
      </div>

      <ChargerDetail charger={openCharger} onClose={() => setOpenId(null)} />
    </div>
  );
}
