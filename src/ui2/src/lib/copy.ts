export type ChargerRuntimeStatus =
  "unplugged" | "plugged_paused" | "waiting_cheap" | "charging" | "ready" | "fast_charging" | "off";

export const statusLabel = (s: ChargerRuntimeStatus): string => {
  switch (s) {
    case "unplugged":
      return "Nothing connected";
    case "plugged_paused":
      return "Plugged in — paused";
    case "waiting_cheap":
      return "Waiting for cheap power";
    case "charging":
      return "Charging";
    case "ready":
      return "Ready";
    case "fast_charging":
      return "Charging fast";
    case "off":
      return "Off";
  }
};

export const statusTone = (s: ChargerRuntimeStatus): "ok" | "warn" | "muted" | "bad" => {
  if (s === "charging" || s === "ready" || s === "fast_charging") return "ok";
  if (s === "waiting_cheap" || s === "plugged_paused") return "warn";
  if (s === "off") return "bad";
  return "muted";
};

export const modeLabel = { off: "Off", smart: "Smart", fast: "Fast" } as const;

export const REGIONS = [
  { id: "SE1", label: "SE1 · Northern Sweden" },
  { id: "SE2", label: "SE2 · Northern-Central Sweden" },
  { id: "SE3", label: "SE3 · Southern-Central Sweden" },
  { id: "SE4", label: "SE4 · Southern Sweden" },
  { id: "EE", label: "EE · Estonia" },
  { id: "LV", label: "LV · Latvia" },
  { id: "LT", label: "LT · Lithuania" },
  { id: "FI", label: "FI · Finland" },
] as const;
