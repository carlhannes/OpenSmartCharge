export const fmtKW = (w: number) => `${(w / 1000).toFixed(w >= 10000 ? 0 : 1)} kW`;
export const fmtPct = (p: number) => `${Math.round(p)}%`;
export const fmtKWh = (kwh: number) => `${kwh.toFixed(1)} kWh`;
export const fmtKm = (km: number) => `${Math.round(km)} km`;
export const fmtCents = (n: number) => `€${n.toFixed(2)}`;
export const fmtAmps = (a: number) => `${a.toFixed(0)} A`;

export const fmtTime = (d: Date) =>
  d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export const fmtDate = (d: Date) =>
  d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

export const fmtDuration = (mins: number) => {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

export const DAYS = ["M", "T", "W", "T", "F", "S", "S"] as const;
export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAY_KEYS)[number];
