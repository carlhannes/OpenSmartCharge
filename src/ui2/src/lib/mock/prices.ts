// Deterministic-ish 24h price curve (€/kWh). Cheap at night, peaks morning + evening.
export function generatePrices(seed = 0): number[] {
  const out: number[] = [];
  for (let h = 0; h < 24; h++) {
    const morning = Math.exp(-Math.pow((h - 8) / 2.2, 2)) * 0.22;
    const evening = Math.exp(-Math.pow((h - 19) / 2.4, 2)) * 0.26;
    const night = Math.exp(-Math.pow((h - 3) / 3, 2)) * -0.06;
    const base = 0.12;
    const jitter = (Math.sin((h + seed) * 1.7) + Math.cos((h + seed) * 0.9)) * 0.012;
    out.push(Math.max(0.03, base + morning + evening + night + jitter));
  }
  return out;
}
