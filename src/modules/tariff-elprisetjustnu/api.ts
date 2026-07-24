import type { TariffSlot } from '../../sdk/tariff.js'
import { ZoneNotFoundError } from '../../sdk/nordpool-tariff.js'
import { localDateKey } from '../../sdk/local-time.js'
import type { ElprisetRecord } from './types.js'

const BASE = 'https://www.elprisetjustnu.se/api/v1/prices'
// elprisetjustnu publishes one file per SWEDISH (Nord Pool market) calendar day — CET/CEST,
// independent of the site/user timezone.
const MARKET_TZ = 'Europe/Stockholm'
const FETCH_TIMEOUT_MS = 15_000
const VALID_ZONE = /^SE[1-4]$/

// Fetch SE1–SE4 day-ahead prices covering [from, to) from elprisetjustnu.se.
// Prices are published per Stockholm calendar day (one JSON file per day per zone), so we
// fetch every day the range touches and concatenate. Tomorrow's file 404s until it is
// published (~13:00 CET) — treated as "not yet available", not an error.
// Slots are 15-minute (Nord Pool 15-min settlement) and priced in SEK/kWh (the user's
// actual cost). Throws ZoneNotFoundError for a zone outside SE1–SE4 (permanent misconfig).
export async function fetchElprisetPrices(
  zone: string,
  from: Date,
  to: Date,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<TariffSlot[]> {
  if (!VALID_ZONE.test(zone)) throw new ZoneNotFoundError(zone, 'elprisetjustnu')

  // Unique Stockholm-local calendar days the [from, to] range touches. Step 12 h so no day
  // is skipped even across a 23-hour DST day; the Set dedupes repeated keys.
  const dayKeys = new Set<string>()
  for (let t = from.getTime(); t <= to.getTime(); t += 12 * 3600_000) {
    dayKeys.add(localDateKey(new Date(t), MARKET_TZ))
  }
  dayKeys.add(localDateKey(to, MARKET_TZ))

  const slots: TariffSlot[] = []
  let published = 0
  for (const key of dayKeys) {
    const [y, m, d] = key.split('-')
    const url = `${BASE}/${y}/${m}-${d}_${zone}.json`
    const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (res.status === 404) continue // that day isn't published yet
    if (!res.ok) throw new Error(`elprisetjustnu HTTP ${res.status}: ${res.statusText}`)
    const records = (await res.json()) as ElprisetRecord[]
    published++
    for (const r of records) {
      slots.push({
        start: new Date(r.time_start),
        end: new Date(r.time_end),
        pricePerKWh: r.SEK_per_kWh,
        currency: 'SEK',
      })
    }
  }

  // Every day 404'd → today's file was missing too, which is a zone/service problem (not the
  // normal "tomorrow not published yet"). Surface it as a transient failure so the scheduler
  // retries instead of silently caching nothing.
  if (published === 0) {
    throw new Error(`elprisetjustnu: no published data for zone ${zone}`)
  }
  return slots
}
