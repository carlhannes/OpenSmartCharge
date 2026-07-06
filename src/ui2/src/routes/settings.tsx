import { createFileRoute, Outlet, Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Settings — OpenSmartCharge" }] }),
  component: SettingsLayout,
});

const sections = [
  { to: "/settings/chargers", label: "Chargers", desc: "Names, amp limits, pending." },
  { to: "/settings/vehicles", label: "Vehicles", desc: "Škoda / VW logins, guest defaults." },
  {
    to: "/settings/region",
    label: "Electricity region",
    desc: "Price zone (SE1–SE4, EE, LV, LT, FI).",
  },
  { to: "/settings/house", label: "House & load balancing", desc: "Breaker, Tibber Pulse, meter." },
  { to: "/settings/system", label: "System status", desc: "Modules, health, backup." },
  { to: "/settings/logs", label: "Logs", desc: "System logs — filter by level and date." },
  { to: "/settings/about", label: "About", desc: "Version, docs, reset." },
];

function SettingsLayout() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const atRoot = pathname === "/settings" || pathname === "/settings/";

  return (
    <div className="mx-auto max-w-2xl px-5 pt-10 pb-8 md:pt-14">
      <div className="mb-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Settings
      </div>
      <h1 className="font-display text-4xl font-semibold tracking-tight">
        {atRoot
          ? "How it's set up"
          : (sections.find((s) => pathname.startsWith(s.to))?.label ?? "Settings")}
      </h1>

      {atRoot ? (
        <div className="mt-8 space-y-2">
          {sections.map((s) => (
            <Link
              key={s.to}
              to={s.to}
              className="flex items-center justify-between rounded-2xl border border-border/60 bg-card p-4 transition hover:shadow-sm"
            >
              <div>
                <div className="font-medium">{s.label}</div>
                <div className="text-xs text-muted-foreground">{s.desc}</div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>
          ))}
        </div>
      ) : (
        <div className="mt-6">
          <Link
            to="/settings"
            className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            ← All settings
          </Link>
          <Outlet />
        </div>
      )}
    </div>
  );
}
