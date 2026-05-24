import type { MeterSnapshot } from '../../sdk/meter-reader.js'

const RE_POWER = /1-0:1\.7\.0\((?<kw>[0-9.]+)\*kW\)/
const RE_I1 = /1-0:31\.7\.0\((?<a>[0-9.]+)\*A\)/
const RE_I2 = /1-0:51\.7\.0\((?<a>[0-9.]+)\*A\)/
const RE_I3 = /1-0:71\.7\.0\((?<a>[0-9.]+)\*A\)/

export function extractMetrics(text: string): Omit<MeterSnapshot, 'timestamp'> {
  const result: Omit<MeterSnapshot, 'timestamp'> = {}

  const mPower = RE_POWER.exec(text)
  if (mPower?.groups?.kw) result.powerW = Math.round(parseFloat(mPower.groups.kw) * 1000)

  const mI1 = RE_I1.exec(text)
  if (mI1?.groups?.a) result.i1A = parseFloat(mI1.groups.a)

  const mI2 = RE_I2.exec(text)
  if (mI2?.groups?.a) result.i2A = parseFloat(mI2.groups.a)

  const mI3 = RE_I3.exec(text)
  if (mI3?.groups?.a) result.i3A = parseFloat(mI3.groups.a)

  return result
}
