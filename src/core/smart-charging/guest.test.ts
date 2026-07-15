import { test, expect } from 'vitest'
import { resolveActiveVehicle, positiveClaimant, GUEST, type ActiveVehicleInput } from './guest.js'

const R = (pairs: Record<string, boolean | undefined>): ActiveVehicleInput['readings'] =>
  Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, { pluggedIn: v }]))

const base: ActiveVehicleInput = {
  candidates: ['enyaq'],
  connected: true,
  readings: {},
  override: undefined,
  latched: null,
}

test('not connected → null (no session), regardless of override', () => {
  expect(resolveActiveVehicle({ ...base, connected: false, override: 'enyaq' })).toBeNull()
})

test('single-candidate back-compat: trust the lone car unless it POSITIVELY reports unplugged', () => {
  expect(resolveActiveVehicle({ ...base, readings: {} })).toBe('enyaq') // unknown → present
  expect(resolveActiveVehicle({ ...base, readings: R({ enyaq: true }) })).toBe('enyaq')
  expect(resolveActiveVehicle({ ...base, readings: R({ enyaq: false }) })).toBeNull() // guest
})

test('multi-candidate: a single positive app-claim identifies the car', () => {
  expect(
    resolveActiveVehicle({
      ...base,
      candidates: ['enyaq', 'vw'],
      readings: R({ enyaq: true, vw: false }),
    }),
  ).toBe('enyaq')
})

test('multi-candidate: no claim, no override → guest (never guess among several)', () => {
  expect(
    resolveActiveVehicle({ ...base, candidates: ['enyaq', 'vw'], readings: R({}) }),
  ).toBeNull()
})

test('a single positive claim SUPERSEDES a sticky override (auto-detected another car)', () => {
  expect(
    resolveActiveVehicle({
      ...base,
      candidates: ['enyaq', 'opel'],
      override: 'opel',
      readings: R({ enyaq: true }),
    }),
  ).toBe('enyaq')
})

test('sticky override honored when there is no positive claim', () => {
  // manual Opel picked; no app-car claims → stays Opel
  expect(
    resolveActiveVehicle({
      ...base,
      candidates: ['enyaq', 'opel'],
      override: 'opel',
      readings: R({ enyaq: undefined }),
    }),
  ).toBe('opel')
  // forced Guest → null even with unknown plug state
  expect(resolveActiveVehicle({ ...base, override: GUEST, readings: R({ enyaq: undefined }) })).toBeNull()
  // override naming a non-candidate → guest (defensive)
  expect(resolveActiveVehicle({ ...base, override: 'ghost' })).toBeNull()
})

test('ambiguous (≥2 claim): keep the latched claimant, else guest', () => {
  const readings = R({ enyaq: true, vw: true })
  const cand = ['enyaq', 'vw']
  expect(resolveActiveVehicle({ ...base, candidates: cand, readings, latched: 'vw' })).toBe('vw')
  expect(resolveActiveVehicle({ ...base, candidates: cand, readings, latched: null })).toBeNull()
})

test('multi-candidate latch holds until the latched car positively leaves', () => {
  const cand = ['enyaq', 'vw']
  expect(
    resolveActiveVehicle({ ...base, candidates: cand, readings: R({ enyaq: undefined }), latched: 'enyaq' }),
  ).toBe('enyaq')
  expect(
    resolveActiveVehicle({ ...base, candidates: cand, readings: R({ enyaq: false }), latched: 'enyaq' }),
  ).toBeNull()
})

test('positiveClaimant: exactly one true → it; zero or ≥2 → null', () => {
  expect(positiveClaimant(['a', 'b'], R({ a: true, b: false }))).toBe('a')
  expect(positiveClaimant(['a', 'b'], R({ a: true, b: true }))).toBeNull()
  expect(positiveClaimant(['a', 'b'], R({}))).toBeNull()
})
