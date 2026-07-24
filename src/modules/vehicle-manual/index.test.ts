import { test, expect } from 'vitest'
import './index.js' // registers the 'manual' vehicle type (side-effect)
import { getVehicleModule } from '../../sdk/registry-api.js'
import type { ModuleCtx } from '../../sdk/types.js'

test('manual vehicle: registered, no telemetry, kWh-only, never auto-identified', async () => {
  const mod = getVehicleModule('manual')
  expect(mod).toBeDefined()
  const v = mod!.create({ name: 'opel' }, {} as unknown as ModuleCtx)

  expect(v.id).toBe('opel')
  // All-false capabilities → targetUnitsFor yields kWh-only, autoIdentifiable is false (see energy.ts).
  expect(v.capabilities).toEqual({
    soc: false,
    range: false,
    capacity: false,
    presence: false,
    climate: false,
    targetSoc: false,
  })
  expect(v.getCachedCapacity()).toBeUndefined()
  expect(v.health()).toBe('ok')
  // No telemetry — getData/refresh reject; consumers already tolerate this (.catch → undefined).
  await expect(v.getData()).rejects.toThrow()
  await expect(v.refresh()).rejects.toThrow()
})
