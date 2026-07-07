import { test, expect } from 'vitest'
import { parseConfig } from './types.js'

test('parseConfig: parses the reader broker; defaults topicPrefix=house, staleAfterSec=60', () => {
  const c = parseConfig({
    name: 'house',
    type: 'mqtt-phase',
    broker: { host: '192.168.3.12', user: 'evcc', password: 'x' },
  })
  expect(c).toMatchObject({
    name: 'house',
    type: 'mqtt-phase',
    topicPrefix: 'house',
    staleAfterSec: 60,
  })
  expect(c.broker).toEqual({ host: '192.168.3.12', port: 1883, user: 'evcc', password: 'x' })
})

test('parseConfig: honors explicit topicPrefix / staleAfterSec', () => {
  const c = parseConfig({
    name: 'm',
    broker: { host: 'h' },
    topicPrefix: 'grid',
    staleAfterSec: 30,
  })
  expect(c.topicPrefix).toBe('grid')
  expect(c.staleAfterSec).toBe(30)
})

test('parseConfig: throws without a broker (the reader owns its connection now)', () => {
  expect(() => parseConfig({ name: 'house', type: 'mqtt-phase' })).toThrow(/broker/)
  expect(() => parseConfig({ name: 'house', broker: {} })).toThrow(/host/)
})

test('parseConfig: throws without a name', () => {
  expect(() => parseConfig({ broker: { host: 'h' } })).toThrow(/name/)
})
