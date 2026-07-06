import { useEffect, useState } from "react";
import { Archive } from "lucide-react";
import { useOsc } from "@/lib/mock/store";
import { getLogsConfig, setLogsConfig } from "@/lib/api/rest";
import { ActionButton } from "@/components/ui/action-button";

// Log-retention knob for the Logs page. Everything is logged (no min level); rotation by age is the
// only space control. Live: round-trips GET/PUT /api/logs/config. Demo (no backend): local-only.
// Kept in its own file so it composes into settings.logs.tsx with a one-line mount.
export function LogsRetention() {
  const source = useOsc((s) => s.source);
  const [days, setDays] = useState(3);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    if (source === "live") {
      getLogsConfig()
        .then((c) => alive && (setDays(c.retentionDays), setLoaded(true)))
        .catch(() => alive && setLoaded(true));
    } else if (source === "demo") {
      setLoaded(true); // local default; "probing" stays disabled until it resolves
    }
    return () => {
      alive = false;
    };
  }, [source]);

  const clamp = (n: number) => Math.max(1, Math.min(365, Math.round(n || 0)));

  const save = async () => {
    const retentionDays = clamp(days);
    setDays(retentionDays);
    if (source === "live") await setLogsConfig({ retentionDays });
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4">
      <div className="flex items-center gap-2">
        <Archive className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Log retention</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Everything is logged; entries older than this are deleted automatically to save space.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <label htmlFor="log-retention" className="text-sm">
          Keep logs for
        </label>
        <input
          id="log-retention"
          type="number"
          min={1}
          max={365}
          value={days}
          disabled={!loaded}
          onChange={(e) => setDays(Number(e.target.value))}
          className="w-16 rounded-lg border border-input bg-background px-2 py-1 text-sm tabular-nums outline-none disabled:opacity-50"
        />
        <span className="text-sm">days</span>
        <ActionButton
          onRun={save}
          successLabel="Saved"
          disabled={!loaded}
          className="ml-auto rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          Save
        </ActionButton>
      </div>
    </div>
  );
}
