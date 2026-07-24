import { createFileRoute } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { getLogs, type LogEntry, type LogLevel } from "@/lib/api/rest";
import { LEVELS, levelText, fmtClock, timeAgo, groupByDay, RANGES, filterLogs } from "@/lib/logs";
import { InlineStatus } from "@/components/ui/inline-status";
import { LogsRetention } from "@/components/logs-retention";
import { LogsExport } from "@/components/logs-export";
import { Bug, Info, AlertTriangle, XCircle, ChevronDown, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

export const Route = createFileRoute("/settings/logs")({ component: LogsSettings });

const LEVEL_ICON = { debug: Bug, info: Info, warn: AlertTriangle, error: XCircle } as const;

// Synthetic logs for demo mode (no backend). Recent + varied so the viewer looks alive without a server.
function buildDemoLogs(): LogEntry[] {
  const now = Date.now();
  const mk = (
    minAgo: number,
    level: LogLevel,
    module: string,
    msg: string,
    extra?: Partial<LogEntry>,
  ): LogEntry => ({
    id: now - minAgo * 60_000,
    time: new Date(now - minAgo * 60_000).toISOString(),
    level,
    module,
    msg,
    ...extra,
  });
  return [
    mk(1, "info", "loadpoint", "Plan resolved — charging until 07:00"),
    mk(4, "debug", "balancer", "Allocation computed (garage: 16 A)"),
    mk(12, "warn", "vehicle", "Poll slow (2.3s)", { fields: { latencyMs: 2300 } }),
    mk(26, "info", "charger", "Charger connected"),
    mk(53, "error", "ocpp", "Reset failed: timeout", {
      err: "Error: reset timeout\n    at OCPP.reset (ocpp16/server.ts:212)\n    at Loop.tick (lifecycle.ts:820)",
      fields: { attempt: 2, code: "ETIMEDOUT" },
    }),
    mk(90, "info", "tariff", "Prices updated (SE4)"),
    mk(140, "debug", "loadpoint", "tick ok"),
    mk(200, "warn", "meter", "Reading stale — using fallback"),
    mk(60 * 26, "info", "charger", "Session finished (18.2 kWh)"),
    mk(60 * 27, "error", "vehicle", "Auth failed", {
      err: "Error: 401 Unauthorized\n    at Skoda.login (vehicle-skoda.ts:88)",
    }),
    mk(60 * 30, "info", "system", "OpenSmartCharge started"),
  ];
}

function LogsSettings() {
  const source = useOsc((s) => s.source);
  const [level, setLevel] = useState<LogLevel>("warn");
  const [rangeKey, setRangeKey] = useState("live");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [q, setQ] = useState("");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const bounds = useMemo(() => {
    const r = RANGES.find((x) => x.key === rangeKey);
    if (r?.custom)
      return {
        since: customFrom ? new Date(customFrom).toISOString() : undefined,
        until: customTo ? new Date(customTo + "T23:59:59").toISOString() : undefined,
      };
    if (r?.ms) return { since: new Date(Date.now() - r.ms).toISOString(), until: undefined };
    return { since: undefined, until: undefined }; // live
  }, [rangeKey, customFrom, customTo]);

  const refresh = useCallback(async () => {
    const opts = { level, since: bounds.since, until: bounds.until, q: q || undefined, limit: 200 };
    setStatus("loading");
    try {
      const rows = source === "live" ? await getLogs(opts) : filterLogs(buildDemoLogs(), opts);
      setEntries(rows);
      setStatus("idle");
      setLastFetched(Date.now());
    } catch {
      setStatus("error");
      setEntries([]);
    }
  }, [level, bounds.since, bounds.until, q, source]);

  // Fetch on mount + whenever filters change.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // "updated Xs ago" ticker.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Auto-poll only for the "Live" (latest) view — historical ranges are static.
  useEffect(() => {
    if (rangeKey !== "live") return;
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [rangeKey, refresh]);

  const groups = useMemo(() => groupByDay(entries), [entries]);

  return (
    <div className="space-y-4">
      {/* Sticky filter bar */}
      <div className="sticky top-0 z-10 -mx-5 space-y-2 border-b border-border/60 bg-background/95 px-5 pb-3 backdrop-blur">
        <div className="grid grid-cols-4 gap-1 rounded-2xl bg-secondary p-1">
          {LEVELS.map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={`rounded-xl px-2 py-1.5 text-xs font-medium capitalize transition ${
                level === l ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              {l}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRangeKey(r.key)}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition ${
                rangeKey === r.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
          <button
            onClick={() => void refresh()}
            aria-label="Refresh"
            className="ml-auto shrink-0 rounded-full p-1.5 text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={`h-4 w-4 ${status === "loading" ? "animate-spin" : ""}`} />
          </button>
          <LogsExport
            level={level}
            since={bounds.since}
            until={bounds.until}
            q={q || undefined}
            source={source}
            entries={entries}
          />
        </div>

        {rangeKey === "custom" && (
          <div className="flex items-center gap-2 text-xs">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-lg border border-input bg-background px-2 py-1"
            />
            <span className="text-muted-foreground">→</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-lg border border-input bg-background px-2 py-1"
            />
          </div>
        )}

        <div className="flex items-center gap-2 rounded-lg border border-input bg-background px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter messages…"
            className="w-full bg-transparent text-sm outline-none"
          />
        </div>

        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            {entries.length} {entries.length === 1 ? "entry" : "entries"} · {level}+
          </span>
          {lastFetched != null && (
            <span className="tabular-nums">updated {timeAgo(lastFetched, nowTick)}</span>
          )}
        </div>
      </div>

      {/* Body */}
      {status === "error" ? (
        <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          Logs unavailable — couldn’t reach the backend’s <code>/api/logs</code>.
        </div>
      ) : entries.length === 0 ? (
        status === "loading" ? (
          <InlineStatus state="loading">Loading logs…</InlineStatus>
        ) : (
          <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            No logs match these filters.
          </div>
        )
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="mb-1 px-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">
                {g.label}
              </div>
              <div className="overflow-hidden rounded-2xl border border-border/60 bg-card">
                {g.entries.map((e, i) => {
                  const Icon = LEVEL_ICON[e.level];
                  const open = openId === e.id;
                  const fields =
                    e.fields && Object.keys(e.fields).length > 0 ? e.fields : undefined;
                  const expandable = !!(e.err || fields);
                  return (
                    <button
                      key={e.id}
                      onClick={() => expandable && setOpenId(open ? null : e.id)}
                      className={`flex w-full items-start gap-3 px-3 py-2.5 text-left ${
                        i > 0 ? "border-t border-border/60" : ""
                      } ${expandable ? "hover:bg-secondary/40" : "cursor-default"}`}
                    >
                      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${levelText[e.level]}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                            {fmtClock(new Date(e.time))}
                          </span>
                          {e.module && (
                            <span className="shrink-0 text-xs font-medium">{e.module}</span>
                          )}
                          <span className={`text-sm ${open ? "" : "truncate"}`}>{e.msg}</span>
                        </div>
                        {open && (
                          <div className="mt-2 space-y-2">
                            <div className="text-[11px] text-muted-foreground">
                              {new Date(e.time).toLocaleString()}
                            </div>
                            {e.err && (
                              <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-secondary p-2 text-[11px] leading-relaxed">
                                {e.err}
                              </pre>
                            )}
                            {fields && (
                              <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-secondary p-2 text-[11px] leading-relaxed">
                                {JSON.stringify(fields, null, 2)}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                      {expandable && (
                        <ChevronDown
                          className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition ${
                            open ? "rotate-180" : ""
                          }`}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <LogsRetention />
    </div>
  );
}
