import { createFileRoute, Link } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { fmtKWh, fmtCents, fmtDate, fmtDuration } from "@/lib/format";
import { useMemo } from "react";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "History — OpenSmartCharge" },
      { name: "description", content: "Past charging sessions with energy and cost." },
    ],
  }),
  component: HistoryPage,
});

function HistoryPage() {
  const rawSessions = useOsc((s) => s.sessions);
  const sessions = useMemo(
    () => [...rawSessions].sort((a, b) => b.startedAt - a.startedAt),
    [rawSessions],
  );
  const weekTotal = useMemo(
    () =>
      sessions
        .filter((s) => s.startedAt > Date.now() - 7 * 86400000)
        .reduce((acc, s) => ({ kwh: acc.kwh + s.kwh, cost: acc.cost + s.costEur }), {
          kwh: 0,
          cost: 0,
        }),
    [sessions],
  );

  return (
    <div className="mx-auto max-w-2xl px-5 pt-10 pb-8 md:pt-14">
      <div className="mb-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">
        This week
      </div>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          {fmtKWh(weekTotal.kwh)}
        </h1>
        <div className="text-muted-foreground">≈ {fmtCents(weekTotal.cost)}</div>
      </div>

      <div className="mt-8 space-y-3">
        {sessions.map((s) => (
          <Link
            key={s.id}
            to="/history/$sessionId"
            params={{ sessionId: s.id }}
            className="flex items-center justify-between rounded-2xl border border-border/60 bg-card p-4 transition hover:shadow-sm"
          >
            <div>
              <div className="font-medium">{fmtDate(new Date(s.startedAt))}</div>
              <div className="text-xs text-muted-foreground">
                {fmtDuration((s.endedAt - s.startedAt) / 60000)} · 🚗 {s.vehicleName}
              </div>
            </div>
            <div className="text-right">
              <div className="font-display tabular-nums">{fmtKWh(s.kwh)}</div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {fmtCents(s.costEur)}
              </div>
            </div>
          </Link>
        ))}
        {sessions.length === 0 && (
          <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            No sessions yet.
          </div>
        )}
      </div>
    </div>
  );
}
