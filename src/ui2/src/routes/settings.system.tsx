import { createFileRoute } from "@tanstack/react-router";
import { useOsc } from "@/lib/mock/store";
import { setTimezone, importBackup, restartSystem } from "@/lib/live/commands";
import { configExportUrl } from "@/lib/api/rest";
import { waitForHealthy } from "@/lib/live/restart-flow";
import { InlineStatus, type InlineStatusState } from "@/components/ui/inline-status";
import { useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/settings/system")({ component: SystemSettings });

const tone = { ok: "bg-status-ok", warn: "bg-status-warn", bad: "bg-status-bad" };
const TZ_FALLBACK = [
  "UTC",
  "Europe/Stockholm",
  "Europe/Oslo",
  "Europe/Copenhagen",
  "Europe/Helsinki",
  "Europe/Berlin",
  "Europe/London",
];

function SystemSettings() {
  const modules = useOsc((s) => s.moduleHealth);
  const timezone = useOsc((s) => s.timezone);
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ state: InlineStatusState; msg: string }>({
    state: "idle",
    msg: "",
  });
  const [tzStatus, setTzStatus] = useState<InlineStatusState>("idle");
  const [withSecrets, setWithSecrets] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState<string[] | null>(null);
  // Import MERGES by default (safe — adds/overlays, never wipes). Opt-in "replace" clears existing config first.
  const [replaceMode, setReplaceMode] = useState(false);
  const [restartPhase, setRestartPhase] = useState<"idle" | "confirm" | "restarting" | "timeout">(
    "idle",
  );

  // Full IANA list when the runtime supports it (all modern browsers); else a small Nordic set.
  const zones = useMemo(() => {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: "timeZone") => string[] })
      .supportedValuesOf;
    try {
      const all = supported?.("timeZone");
      if (all && all.length) return all;
    } catch {
      /* older runtime → fall back */
    }
    return TZ_FALLBACK;
  }, []);
  const tzOptions = zones.includes(timezone) ? zones : [timezone, ...zones];

  const changeTz = (tz: string) => {
    void setTimezone(tz); // optimistic local + PUT /api/settings when live
    setTzStatus("success");
  };

  // Real config backup: download the osc.yaml document from the backend (creds only with ?secrets=1).
  const exportConfig = async () => {
    setStatus({ state: "loading", msg: "Preparing backup…" });
    try {
      const res = await fetch(configExportUrl(withSecrets));
      if (!res.ok) throw new Error(`export failed (${res.status})`);
      const text = await res.text();
      const blob = new Blob([text], { type: "text/yaml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `osc-config${withSecrets ? "-full" : ""}.yaml`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus({ state: "success", msg: `Downloaded ${a.download}` });
    } catch (e) {
      setStatus({ state: "error", msg: (e as Error).message });
    }
  };

  // Import: read the file, dry-run to preview the sections (or surface a validation error), then the
  // user confirms → real import (merge by default; replace only if opted in) → restart to apply.
  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setImportPreview(null);
    setStatus({ state: "loading", msg: `Checking ${f.name}…` });
    const text = await f.text();
    setImportText(text);
    try {
      const r = await importBackup(text, replaceMode ? "replace" : "merge", true);
      setImportPreview(r.sections);
      setStatus({ state: "idle", msg: "" });
    } catch (err) {
      setStatus({ state: "error", msg: (err as Error).message });
    }
  };

  const confirmImport = async () => {
    setStatus({ state: "loading", msg: "Importing…" });
    try {
      await importBackup(importText, replaceMode ? "replace" : "merge", false);
    } catch (err) {
      setStatus({ state: "error", msg: (err as Error).message });
      return;
    }
    setImportPreview(null);
    await doRestart(); // applies on restart
  };

  const doRestart = async () => {
    setRestartPhase("restarting");
    try {
      await restartSystem();
    } catch {
      /* the process may exit before the response lands — treat as fired */
    }
    const ok = await waitForHealthy();
    if (ok) window.location.reload();
    else setRestartPhase("timeout");
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <label className="mb-1 block text-xs uppercase tracking-widest text-muted-foreground">
          Timezone
        </label>
        <p className="mb-2 text-xs text-muted-foreground">
          Used for night windows, plan “ready by” times, and price alignment.
        </p>
        <select
          value={timezone}
          onChange={(e) => changeTz(e.target.value)}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
        >
          {tzOptions.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <InlineStatus state={tzStatus} className="mt-2">
          Timezone saved
        </InlineStatus>
      </div>

      <div className="space-y-2">
        {modules.map((m) => (
          <div
            key={m.id}
            className="flex items-start gap-3 rounded-2xl border border-border/60 bg-card p-4"
          >
            <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${tone[m.status]}`} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="font-medium">{m.name}</div>
                {m.type && (
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {m.type}
                  </span>
                )}
              </div>
              {m.message && <div className="text-xs text-muted-foreground">{m.message}</div>}
            </div>
          </div>
        ))}
      </div>

      {/* Real config backup — the osc.yaml document (chargers/vehicles/tariffs/breaker/plans/timezone). */}
      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="mb-2 font-medium">Backup &amp; restore</div>
        <p className="mb-3 text-xs text-muted-foreground">
          Download your configuration as an <code>osc.yaml</code> file, or restore one. Restoring{" "}
          <span className="font-medium">merges</span> into the current config (applied on restart) —
          tick Replace below to wipe it first instead.
        </p>
        <label className="mb-3 flex items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={withSecrets}
            onChange={(e) => setWithSecrets(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Include credentials (vehicle passwords) — needed to move a car between installs, but the
            file will contain secrets in <span className="font-medium">plain text</span>.
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void exportConfig()}
            className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Export
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-full border border-input px-4 py-2 text-sm font-medium"
          >
            Import…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".yaml,.yml,text/yaml"
            className="hidden"
            onChange={(e) => void onImportFile(e)}
          />
        </div>
        <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={replaceMode}
            onChange={(e) => setReplaceMode(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Replace instead of merge — <span className="font-medium">wipes</span> the current config
            first. Leave off to merge (adds/overlays, keeping anything not in the file).
          </span>
        </label>
        {importPreview && (
          <div className="mt-3 rounded-lg bg-secondary/60 p-3 text-xs">
            <div className="mb-2">Ready to import: {importPreview.join(", ")}.</div>
            <div className="flex gap-2">
              <button
                onClick={() => void confirmImport()}
                className="rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
              >
                Import &amp; restart
              </button>
              <button
                onClick={() => {
                  setImportPreview(null);
                  setImportText("");
                }}
                className="rounded-full border border-input px-3 py-1.5 text-xs font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <InlineStatus state={status.state} className="mt-2">
          {status.msg}
        </InlineStatus>
      </div>

      {/* Restart the OSC process (graceful). Only returns under a supervisor (systemd/docker). */}
      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="mb-1 font-medium">Restart OSC</div>
        <p className="mb-3 text-xs text-muted-foreground">
          Gracefully restarts the service. Under systemd/docker it comes back in a few seconds; if
          you started it manually you'll need to start it again.
        </p>
        {restartPhase === "restarting" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="h-2 w-2 animate-pulse rounded-full bg-primary" /> Restarting… this page
            reloads when OSC is back.
          </div>
        ) : restartPhase === "timeout" ? (
          <div className="text-sm text-status-warn">
            OSC hasn't come back yet. Under systemd/docker it should return shortly — reload this
            page. If you started it manually, start it again, then reload.
          </div>
        ) : restartPhase === "confirm" ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() => void doRestart()}
              className="rounded-full bg-status-bad px-4 py-2 text-sm font-medium text-white"
            >
              Confirm restart
            </button>
            <button
              onClick={() => setRestartPhase("idle")}
              className="rounded-full border border-input px-4 py-2 text-sm font-medium"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setRestartPhase("confirm")}
            className="rounded-full border border-input px-4 py-2 text-sm font-medium"
          >
            Restart OSC
          </button>
        )}
      </div>
    </div>
  );
}
