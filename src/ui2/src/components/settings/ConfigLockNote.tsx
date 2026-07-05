import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { CONFIG_LOCK_NOTE } from "@/lib/copy";

/**
 * Muted inline note for config controls with no write API yet. The control still shows the real
 * value (hydrated from /api/site) but is read-only in live mode until the backend exposes a write
 * route — see docs/ui2-api-wishlist.md. Pass `children` to override the default text.
 */
export function ConfigLockNote({ children }: { children?: ReactNode }) {
  return (
    <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Lock className="h-3 w-3 shrink-0" />
      <span>{children ?? CONFIG_LOCK_NOTE}</span>
    </div>
  );
}
