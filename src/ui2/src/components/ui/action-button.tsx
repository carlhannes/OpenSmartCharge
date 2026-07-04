import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Phase = "idle" | "pending" | "success" | "error";

/**
 * A button that confirms itself (P2) — the button the user clicked becomes the
 * feedback surface, so it can't be missed the way a floating overlay can. Runs `onRun` and flows
 * idle → "Sending…" → "✓ <successLabel>" (auto-reverts) or "✗ <error>". If `onRun`
 * throws, the thrown message (if any) is shown. Fits fire-and-forget commands.
 */
export function ActionButton({
  children,
  onRun,
  successLabel = "Sent",
  className,
  disabled,
}: {
  children: ReactNode;
  onRun: () => void | Promise<void>;
  successLabel?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [errLabel, setErrLabel] = useState<ReactNode>("Failed");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const run = async () => {
    if (phase === "pending") return;
    setPhase("pending");
    try {
      await onRun();
      setPhase("success");
    } catch (e) {
      setErrLabel(e instanceof Error ? e.message : "Failed");
      setPhase("error");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPhase("idle"), 1800);
  };

  return (
    <button
      type="button"
      disabled={disabled || phase === "pending"}
      onClick={run}
      aria-busy={phase === "pending"}
      className={cn(
        "inline-flex items-center justify-center gap-1.5",
        phase === "success" && "text-status-ok",
        phase === "error" && "text-status-bad",
        className,
      )}
    >
      {phase === "pending" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
      {phase === "success" && <Check className="h-3.5 w-3.5 shrink-0" />}
      {phase === "error" && <X className="h-3.5 w-3.5 shrink-0" />}
      <span>
        {phase === "pending"
          ? "Sending…"
          : phase === "success"
            ? successLabel
            : phase === "error"
              ? errLabel
              : children}
      </span>
    </button>
  );
}
