// Shared "restart OSC, then reconnect" helper. After POST /api/system/restart the process drains +
// exits; under a supervisor (systemd Restart=always / a docker restart policy) it comes back within a
// few seconds. We poll GET /api/health until it responds again, then callers hard-reload so the app
// re-syncs from a clean state (simpler + more reliable than re-driving the live-sync internals).
import * as api from "@/lib/api/rest";

/** Poll GET /api/health until the backend answers again (it just restarted), or give up. Returns true
 *  once healthy, false on timeout. A short initial delay avoids catching the still-draining old process
 *  before it has exited. */
export async function waitForHealthy(timeoutMs = 60000, intervalMs = 2000): Promise<boolean> {
  await new Promise((r) => setTimeout(r, 1500));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await api.getHealth();
      return true;
    } catch {
      // backend not back yet — keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
