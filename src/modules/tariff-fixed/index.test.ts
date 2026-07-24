import { test, expect } from 'vitest'
import './index.js' // registers the 'fixed' tariff module
import { getTariffModule } from '../../sdk/registry-api.js'
import { generateFlatSlots } from './index.js'

test('generateFlatSlots: contiguous hourly slots spanning the window, all at the flat price', () => {
  const from = new Date('2026-01-01T10:20:00Z')
  const to = new Date('2026-01-01T13:00:00Z')
  const slots = generateFlatSlots(from, to, 0.5, 'SEK')

  expect(slots.length).toBeGreaterThanOrEqual(3)
  expect(slots.every((s) => s.pricePerKWh === 0.5 && s.currency === 'SEK')).toBe(true)
  expect(slots[0].start.getTime()).toBeLessThanOrEqual(from.getTime()) // first slot covers `from`
  expect(slots[slots.length - 1].end.getTime()).toBeGreaterThanOrEqual(to.getTime()) // reaches `to`
  for (let i = 1; i < slots.length; i++)
    expect(slots[i].start.getTime()).toBe(slots[i - 1].end.getTime()) // contiguous, no gaps
})

test('the registered "fixed" tariff yields flat prices and is always healthy', async () => {
  const mod = getTariffModule('fixed')
  expect(mod).toBeDefined()
  const t = mod!.create({ name: 'flat', pricePerKWh: 1.25 }, {} as never)
  expect(t.health()).toBe('ok')
  const slots = await t.prices(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T06:00:00Z'))
  expect(slots.length).toBeGreaterThan(0)
  expect(slots.every((s) => s.pricePerKWh === 1.25)).toBe(true)
})

test('the "fixed" tariff defaults to 0 price / SEK when unconfigured', async () => {
  const t = getTariffModule('fixed')!.create({ name: 'flat' }, {} as never)
  const slots = await t.prices(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T02:00:00Z'))
  expect(slots.every((s) => s.pricePerKWh === 0 && s.currency === 'SEK')).toBe(true)
})
