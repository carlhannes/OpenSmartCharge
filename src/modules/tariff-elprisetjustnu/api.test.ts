import { test, expect } from 'vitest'
import { fetchElprisetPrices } from './api.js'
import { ZoneNotFoundError } from '../../sdk/nordpool-tariff.js'
import type { ElprisetRecord } from './types.js'

const rec = (start: string, end: string, sek: number): ElprisetRecord => ({
  SEK_per_kWh: sek,
  EUR_per_kWh: sek / 11,
  EXR: 11,
  time_start: start,
  time_end: end,
})

// Fake fetch that serves per-day JSON by the date embedded in the URL. A date not present
// (or mapped to 404) responds 404 — mirroring "that day isn't published yet".
function makeFetch(byDate: Record<string, ElprisetRecord[] | 404>, calls: string[] = []) {
  return (async (url: string | URL) => {
    calls.push(String(url))
    const m = String(url).match(/\/(\d{4})\/(\d{2})-(\d{2})_SE\d\.json$/)
    const key = m ? `${m[1]}-${m[2]}-${m[3]}` : ''
    const data = byDate[key]
    if (data === undefined || data === 404) {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => [] }
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => data }
  }) as unknown as typeof globalThis.fetch
}

test('rejects a zone outside SE1–SE4 with ZoneNotFoundError (permanent)', async () => {
  const from = new Date('2026-07-04T10:00:00Z')
  const to = new Date('2026-07-04T14:00:00Z')
  await expect(fetchElprisetPrices('SE9', from, to, makeFetch({}))).rejects.toBeInstanceOf(
    ZoneNotFoundError,
  )
  await expect(fetchElprisetPrices('FI', from, to, makeFetch({}))).rejects.toBeInstanceOf(
    ZoneNotFoundError,
  )
})

test('maps a day file to SEK 15-min slots and requests the right URL', async () => {
  const calls: string[] = []
  const fetchFn = makeFetch(
    {
      '2026-07-04': [
        rec('2026-07-04T00:00:00+02:00', '2026-07-04T00:15:00+02:00', 0.59),
        rec('2026-07-04T00:15:00+02:00', '2026-07-04T00:30:00+02:00', 0.61),
      ],
    },
    calls,
  )
  const slots = await fetchElprisetPrices(
    'SE4',
    new Date('2026-07-04T10:00:00Z'),
    new Date('2026-07-04T14:00:00Z'),
    fetchFn,
  )
  expect(slots).toHaveLength(2)
  expect(slots[0].pricePerKWh).toBe(0.59)
  expect(slots[0].currency).toBe('SEK')
  expect(slots[0].start.toISOString()).toBe('2026-07-03T22:00:00.000Z') // 00:00 CEST = 22:00Z prev day
  expect(calls).toEqual(['https://www.elprisetjustnu.se/api/v1/prices/2026/07-04_SE4.json'])
})

test('tomorrow not yet published (404) is skipped, not an error', async () => {
  const calls: string[] = []
  const fetchFn = makeFetch(
    {
      '2026-07-04': [rec('2026-07-04T12:00:00+02:00', '2026-07-04T12:15:00+02:00', 0.7)],
      '2026-07-05': 404,
    },
    calls,
  )
  const slots = await fetchElprisetPrices(
    'SE4',
    new Date('2026-07-04T10:00:00Z'),
    new Date('2026-07-05T14:00:00Z'),
    fetchFn,
  )
  expect(slots).toHaveLength(1) // only today's slot; tomorrow skipped
  expect(calls.some((u) => u.endsWith('07-04_SE4.json'))).toBe(true)
  expect(calls.some((u) => u.endsWith('07-05_SE4.json'))).toBe(true)
})

test('throws when no day is published (all 404) so the scheduler retries', async () => {
  const from = new Date('2026-07-04T10:00:00Z')
  const to = new Date('2026-07-04T14:00:00Z')
  await expect(fetchElprisetPrices('SE4', from, to, makeFetch({}))).rejects.toThrow(
    /no published data/,
  )
})
