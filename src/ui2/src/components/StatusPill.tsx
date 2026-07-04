import { statusLabel, statusTone, type ChargerRuntimeStatus } from "@/lib/copy";

const toneClass: Record<ReturnType<typeof statusTone>, string> = {
  ok: "bg-status-ok/15 text-status-ok",
  warn: "bg-status-warn/15 text-status-warn",
  muted: "bg-muted text-muted-foreground",
  bad: "bg-status-bad/15 text-status-bad",
};

const dotClass: Record<ReturnType<typeof statusTone>, string> = {
  ok: "bg-status-ok",
  warn: "bg-status-warn",
  muted: "bg-muted-foreground",
  bad: "bg-status-bad",
};

export function StatusPill({
  status,
  size = "md",
}: {
  status: ChargerRuntimeStatus;
  size?: "sm" | "md";
}) {
  const tone = statusTone(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${toneClass[tone]} ${
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-3 py-1 text-xs"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${dotClass[tone]} ${status === "charging" || status === "fast_charging" ? "animate-pulse" : ""}`}
      />
      {statusLabel(status)}
    </span>
  );
}
