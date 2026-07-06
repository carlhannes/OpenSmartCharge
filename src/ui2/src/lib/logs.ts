// Pure helpers for the Logs viewer (settings.logs.tsx). Kept side-effect-free + easy to reason about.
import { fmtDate } from "@/lib/format";
import type { LogEntry, LogLevel } from "@/lib/api/rest";

export const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
export const levelRank = (l: LogLevel) => LEVELS.indexOf(l);

// Level → color, from the app's status/brand tokens. Shape (icon) + color together, so it reads without
// relying on color alone: error→red, warn→amber, info→sage, debug→grey.
export const levelText: Record<LogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-sage",
  warn: "text-status-warn",
  error: "text-status-bad",
};

export const fmtClock = (d: Date) =>
  d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

/** "3s ago" / "2m ago" / "1h ago" — no relative-time helper exists in format.ts. */
export function timeAgo(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** Group a newest-first list into day sections labelled Today / Yesterday / "Mon, Jul 6". */
export function groupByDay(entries: LogEntry[]): { label: string; entries: LogEntry[] }[] {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const groups: { label: string; entries: LogEntry[] }[] = [];
  let currentKey: string | null = null;
  for (const e of entries) {
    const d = new Date(e.time);
    const key = d.toDateString();
    if (key !== currentKey) {
      currentKey = key;
      const label = key === today ? "Today" : key === yesterday ? "Yesterday" : fmtDate(d);
      groups.push({ label, entries: [] });
    }
    groups[groups.length - 1].entries.push(e);
  }
  return groups;
}

export interface LogRange {
  key: string;
  label: string;
  ms?: number; // window length back from now
  custom?: boolean;
}
export const RANGES: LogRange[] = [
  { key: "live", label: "Live" },
  { key: "1h", label: "1h", ms: 3_600_000 },
  { key: "24h", label: "24h", ms: 86_400_000 },
  { key: "7d", label: "7d", ms: 604_800_000 },
  { key: "custom", label: "Custom", custom: true },
];

/** Client-side filter — used for demo mode (live mode filters server-side). Preserves input order. */
export function filterLogs(
  entries: LogEntry[],
  f: { level?: LogLevel; since?: string; until?: string; q?: string },
): LogEntry[] {
  const minRank = f.level ? levelRank(f.level) : 0;
  const sinceMs = f.since ? Date.parse(f.since) : -Infinity;
  const untilMs = f.until ? Date.parse(f.until) : Infinity;
  const q = f.q?.toLowerCase();
  return entries.filter((e) => {
    if (levelRank(e.level) < minRank) return false;
    const t = Date.parse(e.time);
    if (t < sinceMs || t > untilMs) return false;
    if (q && !`${e.module ?? ""} ${e.msg}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
