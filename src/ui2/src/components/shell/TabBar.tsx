import { Link, useRouterState } from "@tanstack/react-router";
import { Home, History, Settings } from "lucide-react";

const tabs = [
  { to: "/", label: "Home", icon: Home },
  { to: "/history", label: "History", icon: History },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function TabBar() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const isActive = (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-background/85 backdrop-blur-xl md:static md:border-none md:bg-transparent md:backdrop-blur-none"
    >
      <div className="mx-auto flex max-w-3xl items-stretch justify-around px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:max-w-none md:flex-col md:items-stretch md:gap-1 md:p-3">
        {tabs.map(({ to, label, icon: Icon }) => {
          const active = isActive(to);
          return (
            <Link
              key={to}
              to={to}
              className={`group flex flex-1 flex-col items-center gap-1 rounded-2xl px-3 py-2 text-[11px] font-medium tracking-wide transition-colors md:flex-row md:justify-start md:gap-3 md:text-sm ${
                active
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon
                className={`h-5 w-5 ${active ? "text-primary" : ""}`}
                strokeWidth={active ? 2.25 : 1.75}
              />
              <span>{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
