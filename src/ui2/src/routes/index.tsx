import { createFileRoute, Link } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { HeroStatus } from "@/components/home/HeroStatus";
import { ChargerCard } from "@/components/home/ChargerCard";
import { ChargerDetail } from "@/components/charger/ChargerDetail";
import { useState, useMemo } from "react";
import { AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const chargers = useOsc((s) => s.chargers);
  const moduleHealth = useOsc((s) => s.moduleHealth);
  const degraded = useMemo(() => moduleHealth.filter((m) => m.status !== "ok"), [moduleHealth]);
  const [openId, setOpenId] = useState<string | null>(null);
  const openCharger = chargers.find((c) => c.id === openId) ?? null;

  return (
    <div className="mx-auto max-w-2xl">
      <HeroStatus />

      {degraded.length > 0 && (
        <div className="mx-5 mb-4 flex items-start gap-3 rounded-2xl bg-status-warn/10 p-4 text-sm text-status-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">Something's degraded — charging continues.</div>
            <div className="mt-0.5 text-status-warn/80">{degraded[0].message}</div>
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
            params={{ step: "charger" }}
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
