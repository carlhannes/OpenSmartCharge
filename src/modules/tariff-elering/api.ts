import type { TariffSlot } from '../../sdk/tariff.js'
import type { EleringResponse } from './types.js'

const ELERING_BASE = 'https://dashboard.elering.ee/api'
const FETCH_TIMEOUT_MS = 15_000

export class EleringZoneError extends Error {
  constructor(zone: string) {
    super(`Elering: zone '${zone}' not found in response`)
    this.name = 'EleringZoneError'
  }
}

// Fetches price records for the given zone covering the requested range.
// Pass ctx.fetch for scheduled calls (adds thundering-herd jitter) or the
// global fetch for the startup call where an immediate response is needed.
// Throws EleringZoneError when the zone is absent (permanent failure).
// Throws on network / non-2xx (transient failure).
export async function fetchEleringPrices(
  zone: string,
  from: Date,
  to: Date,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<TariffSlot[]> {
  const start = from.toISOString()
  const end = to.toISOString()
  const url = `${ELERING_BASE}/nps/price?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`

  const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) {
    throw new Error(`Elering HTTP ${res.status}: ${res.statusText}`)
  }

  const body = (await res.json()) as EleringResponse
  if (!body.success) {
    throw new Error('Elering response success=false')
  }

  const records = body.data[zone.toLowerCase()]
  if (!records || records.length === 0) {
    throw new EleringZoneError(zone)
  }

  return records.map((r) => ({
    start: new Date(r.timestamp * 1000),
    end: new Date((r.timestamp + 3600) * 1000),
    pricePerKWh: r.price / 1000, // EUR/MWh → EUR/kWh
    currency: 'EUR',
  }))
}
