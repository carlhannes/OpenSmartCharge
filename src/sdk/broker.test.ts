import { test, expect } from 'vitest'
import { brokerSchema, parseBroker } from './broker.js'

test('brokerSchema: port defaults to 1883; user/password optional', () => {
  expect(brokerSchema.parse({ host: 'broker.lan' })).toEqual({ host: 'broker.lan', port: 1883 })
  expect(
    brokerSchema.parse({ host: '192.168.3.12', port: 8883, user: 'u', password: 'p' }),
  ).toEqual({
    host: '192.168.3.12',
    port: 8883,
    user: 'u',
    password: 'p',
  })
})

test('parseBroker returns the parsed broker on valid input', () => {
  expect(
    parseBroker({ host: '192.168.3.12', port: 1883, user: 'evcc', password: 'x' }, 'meter x'),
  ).toEqual({ host: '192.168.3.12', port: 1883, user: 'evcc', password: 'x' })
})

test('parseBroker throws a descriptive error on missing/invalid broker', () => {
  expect(() => parseBroker(undefined, "meter 'house'")).toThrow(/meter 'house'.*broker/)
  expect(() => parseBroker({}, "meter 'house'")).toThrow(/host/)
  expect(() => parseBroker({ host: 5 }, "meter 'house'")).toThrow(/host/)
})
