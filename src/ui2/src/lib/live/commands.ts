// Live/demo command router. In live mode these hit the backend (with an optimistic local
// store update where it helps); in demo mode they fall back to local/simulated behavior.
import { useOsc, type Mode } from "@/lib/mock/store";
import * as api from "@/lib/api/rest";

const isLive = () => useOsc.getState().source === "live";
const toApiMode = (m: Mode): api.ChargeMode => (m === "off" ? "disabled" : m);

/** Mode change: optimistic local update; POST when live (SSE `loadpoint.mode` reconciles). */
export async function changeMode(chargerId: string, mode: Mode): Promise<void> {
  useOsc.getState().setMode(chargerId, mode);
  if (isLive()) await api.setMode(chargerId, toApiMode(mode));
}

/** One-shot amp limit: optimistic local update; POST /profile when live. */
export async function applyOneShot(chargerId: string, amps: number): Promise<void> {
  useOsc.getState().oneShotAmps(chargerId, amps);
  if (isLive()) await api.setProfile(chargerId, amps);
}

/** OCPP command buttons. Throws on API error so the ActionButton surfaces the failure. */
export async function runCommand(chargerId: string, label: string): Promise<void> {
  if (!isLive()) {
    await new Promise((r) => setTimeout(r, 600)); // demo: simulate a round-trip
    return;
  }
  switch (label) {
    case "Start":
      await api.remoteStart(chargerId);
      return;
    case "Stop":
      await api.remoteStop(chargerId);
      return;
    case "Soft reset":
      await api.resetCharger(chargerId, "Soft");
      return;
    case "Hard reset":
      await api.resetCharger(chargerId, "Hard");
      return;
    case "Clear profile":
      await api.clearProfile(chargerId);
      return;
    default:
      return;
  }
}

/** View composite schedule (a read). Demo returns illustrative text; live returns the real JSON. */
export async function viewComposite(chargerId: string): Promise<string> {
  if (!isLive()) {
    return "00:00–06:00 · max A\n06:00–09:00 · 6 A\n09:00–24:00 · max A";
  }
  const result = await api.getCompositeSchedule(chargerId, 3600);
  return JSON.stringify(result, null, 2);
}
