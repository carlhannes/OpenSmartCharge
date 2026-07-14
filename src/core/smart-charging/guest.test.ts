import { test, expect } from 'vitest'
import { resolveActiveVehicle, type ActiveVehicleInput } from './guest.js'

const base: ActiveVehicleInput = {
  boundVehicle: 'enyaq',
  connected: true,
  pluggedIn: undefined,
  override: undefined,
}

test('auto: the bound car is present when it reports plugged, or when its plug state is unknown', () => {
  expect(resolveActiveVehicle({ ...base, pluggedIn: true })).toBe('enyaq')
  // unknown (poll failed) → trust the binding, never guest on a maybe (stability-first)
  expect(resolveActiveVehicle({ ...base, pluggedIn: undefined })).toBe('enyaq')
  // charger not connected → not a live session, so not "guest" either
  expect(resolveActiveVehicle({ ...base, connected: false, pluggedIn: false })).toBe('enyaq')
})

test('auto: guest when the charger is connected but the bound car reports unplugged', () => {
  expect(resolveActiveVehicle({ ...base, connected: true, pluggedIn: false })).toBeNull()
})

test('override forces the answer regardless of pluggedIn', () => {
  expect(resolveActiveVehicle({ ...base, pluggedIn: true, override: 'guest' })).toBeNull()
  expect(resolveActiveVehicle({ ...base, pluggedIn: false, override: 'vehicle' })).toBe('enyaq')
})

test('no bound vehicle → always guest (no SoC source), even with a vehicle override', () => {
  expect(resolveActiveVehicle({ ...base, boundVehicle: undefined })).toBeNull()
  expect(resolveActiveVehicle({ ...base, boundVehicle: undefined, override: 'vehicle' })).toBeNull()
})
