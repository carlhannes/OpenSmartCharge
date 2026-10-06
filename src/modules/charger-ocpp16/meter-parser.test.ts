import { test, expect } from 'vitest'
import { parseMeterValue, latestReadings } from './meter-parser.js'
import type { MeterValue, SampledValue } from './types.js'

function mv(samples: Array<{ measurand?: string; value: string; unit?: string }>): MeterValue {
  return { timestamp: '2026-01-01T00:00:00Z', sampledValue: samples as SampledValue[] }
}

test('parses all measurands, converting energy Wh→kWh', () => {
  const parsed = parseMeterValue(
    mv([
      { measurand: 'Energy.Active.Import.Register', value: '12500' },
      { measurand: 'Power.Active.Import', value: '7400' },
      { measurand: 'Current.Import', value: '16' },
      { measurand: 'Voltage', value: '230' },
      { measurand: 'SoC', value: '55' },
    ]),
  )
  expect(parsed).toEqual({ energyKwh: 12.5, powerW: 7400, currentA: 16, voltageV: 230, socPct: 55 })
})

test('missing measurands are omitted (undefined, never NaN)', () => {
  const parsed = parseMeterValue(mv([{ measurand: 'Voltage', value: '230' }]))
  expect(parsed.voltageV).toBe(230)
  expect(parsed.energyKwh).toBeUndefined()
  expect(parsed.powerW).toBeUndefined()
  expect(parsed.currentA).toBeUndefined()
  expect(parsed.socPct).toBeUndefined()
})

test('empty sampledValue yields all undefined', () => {
  const parsed = parseMeterValue(mv([]))
  expect(parsed.energyKwh).toBeUndefined()
  expect(parsed.powerW).toBeUndefined()
})

test('zero values are preserved, not dropped', () => {
  const parsed = parseMeterValue(
    mv([
      { measurand: 'Power.Active.Import', value: '0' },
      { measurand: 'Energy.Active.Import.Register', value: '0' },
    ]),
  )
  expect(parsed.powerW).toBe(0)
  expect(parsed.energyKwh).toBe(0)
})

test('non-numeric values become undefined', () => {
  const parsed = parseMeterValue(mv([{ measurand: 'Power.Active.Import', value: 'NaN' }]))
  expect(parsed.powerW).toBeUndefined()
})

test('energy Wh→kWh conversion is exact for common values', () => {
  const e = (wh: string) =>
    parseMeterValue(mv([{ measurand: 'Energy.Active.Import.Register', value: wh }])).energyKwh
  expect(e('1000')).toBe(1)
  expect(e('500')).toBe(0.5)
  expect(e('999')).toBe(0.999)
})

test('respects the declared energy unit: kWh is kept, Wh (or absent) is divided by 1000', () => {
  const energy = (value: string, unit?: string) =>
    parseMeterValue(mv([{ measurand: 'Energy.Active.Import.Register', value, unit }])).energyKwh
  expect(energy('12.5', 'kWh')).toBe(12.5) // already kWh — do NOT divide (would be 1000× too small)
  expect(energy('12500', 'Wh')).toBe(12.5) // Wh → kWh
  expect(energy('12500')).toBe(12.5) // absent unit defaults to Wh
})

test('power respects a declared kW unit (W is the default)', () => {
  expect(
    parseMeterValue(mv([{ measurand: 'Power.Active.Import', value: '7.4', unit: 'kW' }])).powerW,
  ).toBe(7400)
  expect(
    parseMeterValue(mv([{ measurand: 'Power.Active.Import', value: '7400', unit: 'W' }])).powerW,
  ).toBe(7400)
  const live = latestReadings({
    connectorId: 1,
    meterValue: [
      {
        timestamp: 't',
        sampledValue: [{ measurand: 'Power.Active.Import', value: '11', unit: 'kW' }],
      },
    ],
  })
  expect(live.powerW).toBe(11000)
})

test('a sample with no measurand is the energy register (the OCPP 1.6 default)', () => {
  expect(parseMeterValue(mv([{ value: '12500', unit: 'Wh' }])).energyKwh).toBe(12.5)
})
