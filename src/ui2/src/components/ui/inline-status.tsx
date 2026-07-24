import { Check, Loader2, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type InlineStatusState = "idle" | "loading" | "success" | "error";

const tone: Record<Exclude<InlineStatusState, "idle">, string> = {
  loading: "text-muted-foreground",
  success: "text-status-ok",
  error: "text-status-bad",
};

/**
 * A persistent, anchored status line for a section (P3) — replaces fire-and-forget
 * overlay notices for things whose result would otherwise be invisible (backup/import, etc.).
 * Renders nothing when idle; stays put until the parent changes `state`.
 */
export function InlineStatus({
  state,
  children,
  className,
}: {
  state: InlineStatusState;
  children?: ReactNode;
  className?: string;
}) {
  if (state === "idle") return null;
  const Icon = state === "loading" ? Loader2 : state === "success" ? Check : X;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex items-center gap-1.5 text-xs", tone[state], className)}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", state === "loading" && "animate-spin")} />
      <span>{children}</span>
    </div>
  );
}
