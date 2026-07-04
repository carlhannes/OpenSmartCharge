import { createFileRoute } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { InlineStatus, type InlineStatusState } from "@/components/ui/inline-status";
import { useRef, useState } from "react";

export const Route = createFileRoute("/settings/system")({ component: SystemSettings });

const tone = { ok: "bg-status-ok", warn: "bg-status-warn", bad: "bg-status-bad" };

function SystemSettings() {
  const modules = useOsc((s) => s.moduleHealth);
  const fileRef = useRef<HTMLInputElement>(null);
  const importJson = useOsc((s) => s.importSnapshot);
  const [status, setStatus] = useState<{ state: InlineStatusState; msg: string }>({
    state: "idle",
    msg: "",
  });

  const exportJson = () => {
    // Serialize the real store state (functions stripped) so the "Downloaded" status is honest.
    const state = useOsc.getState();
    const data = Object.fromEntries(
      Object.entries(state).filter(([, v]) => typeof v !== "function"),
    );
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "osc-backup.json";
    a.click();
    URL.revokeObjectURL(url);
    setStatus({ state: "success", msg: "Downloaded osc-backup.json" });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {modules.map((m) => (
          <div
            key={m.id}
            className="flex items-start gap-3 rounded-2xl border border-border/60 bg-card p-4"
          >
            <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${tone[m.status]}`} />
            <div className="min-w-0">
              <div className="font-medium">{m.name}</div>
              <div className="text-xs text-muted-foreground">{m.message}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="mb-2 font-medium">Backup &amp; restore</div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={exportJson}
            className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Export
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-full border border-input px-4 py-2 text-sm font-medium"
          >
            Import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setStatus({ state: "loading", msg: `Reading ${f.name}…` });
              const text = await f.text();
              if (importJson(text)) setStatus({ state: "success", msg: `Imported ${f.name}` });
              else setStatus({ state: "error", msg: "Not a valid backup file" });
              e.target.value = "";
            }}
          />
        </div>
        <InlineStatus state={status.state} className="mt-2">
          {status.msg}
        </InlineStatus>
      </div>
    </div>
  );
}
