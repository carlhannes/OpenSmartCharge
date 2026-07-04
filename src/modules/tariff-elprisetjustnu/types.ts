// elprisetjustnu.se API response shape — one JSON array per Stockholm calendar day per
// zone, e.g. GET /api/v1/prices/2026/07-04_SE4.json. Docs: https://www.elprisetjustnu.se/elpris-api
export interface ElprisetRecord {
  SEK_per_kWh: number
  EUR_per_kWh: number
  EXR: number // SEK↔EUR exchange rate used
  time_start: string // ISO-8601 with local offset (+01:00 CET / +02:00 CEST)
  time_end: string
}
