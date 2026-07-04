import { createFileRoute, Link } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { fmtKWh, fmtCents, fmtDuration, fmtTime, fmtDate } from "@/lib/format";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { ChevronLeft } from "lucide-react";

export const Route = createFileRoute("/history/$sessionId")({
  head: () => ({ meta: [{ title: "Session — OpenSmartCharge" }] }),
  component: SessionPage,
  notFoundComponent: () => (
    <div className="p-10 text-center text-sm text-muted-foreground">Session not found.</div>
  ),
});

function SessionPage() {
  const { sessionId } = Route.useParams();
  const s = useOsc((st) => st.sessions.find((x) => x.id === sessionId));
  if (!s)
    return <div className="p-10 text-center text-sm text-muted-foreground">Session not found.</div>;

  const points = Array.from({ length: 60 }, (_, i) => {
    const t = i / 60;
    const power = 6 + 4.5 * Math.sin(t * Math.PI * 1.2) + Math.random() * 0.6;
    const soc = (s.socStart ?? 40) + t * ((s.socEnd ?? 80) - (s.socStart ?? 40));
    return { minute: i, power: +power.toFixed(1), soc: +soc.toFixed(1) };
  });

  return (
    <div className="mx-auto max-w-2xl px-5 pt-8 pb-10 md:pt-14">
      <Link
        to="/history"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> History
      </Link>
      <div className="text-xs uppercase tracking-widest text-muted-foreground">Session</div>
      <h1 className="mt-1 font-display text-3xl font-semibold">{fmtDate(new Date(s.startedAt))}</h1>
      <div className="mt-1 text-sm text-muted-foreground">
        {fmtTime(new Date(s.startedAt))} → {fmtTime(new Date(s.endedAt))} ·{" "}
        {fmtDuration((s.endedAt - s.startedAt) / 60000)}
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <Stat label="Energy" value={fmtKWh(s.kwh)} />
        <Stat label="Cost" value={fmtCents(s.costEur)} />
        <Stat label="SoC" value={`${s.socStart ?? "—"}→${s.socEnd ?? "—"}%`} />
      </div>

      <div className="mt-6 rounded-2xl border border-border/60 bg-card p-4">
        <div className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Power & SoC
        </div>
        <div className="h-56 w-full">
          <ResponsiveContainer>
            <AreaChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
              <defs>
                <linearGradient id="g1" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--color-border)" vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="minute" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{
                  background: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="power"
                stroke="var(--color-primary)"
                strokeWidth={2}
                fill="url(#g1)"
                name="kW"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
