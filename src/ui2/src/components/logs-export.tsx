import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { logsExportUrl, type LogEntry, type LogLevel } from "@/lib/api/rest";

// Export the currently-SELECTED logs (current level + time range + search) as a downloadable .log file.
// Live: fetches /api/logs/export (the full filtered set, no viewer limit). Demo: formats the loaded
// entries locally. Lives in its own file so it mounts into the filter bar with one line.
function toLogLine(e: LogEntry): string {
  let line = `${e.time} ${e.level.toUpperCase().padEnd(5)}`;
  if (e.module) line += ` [${e.module}]`;
  line += ` ${e.msg}`;
  if (e.fields && Object.keys(e.fields).length > 0) line += ` ${JSON.stringify(e.fields)}`;
  if (e.err)
    line +=
      "\n" +
      e.err
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n");
  return line;
}

export function LogsExport({
  level,
  since,
  until,
  q,
  source,
  entries,
}: {
  level: LogLevel;
  since?: string;
  until?: string;
  q?: string;
  source: string;
  entries: LogEntry[];
}) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let text: string;
      if (source === "live") {
        const res = await fetch(logsExportUrl({ level, since, until, q }));
        if (!res.ok) throw new Error(String(res.status));
        text = await res.text();
      } else {
        // Demo (no backend): format the loaded, filtered entries oldest-first, like a real logfile.
        text = [...entries].reverse().map(toLogLine).join("\n") + (entries.length > 0 ? "\n" : "");
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `osc-logs-${stamp}.log`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // best-effort — the button just re-enables on failure
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={() => void run()}
      disabled={busy}
      aria-label="Export logs"
      title="Export selected logs (.log)"
      className="shrink-0 rounded-full p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Download className="h-4 w-4" />
      )}
    </button>
  );
}
