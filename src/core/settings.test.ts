import { test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from './db.js'
import {
  getSetting,
  setSetting,
  getTimezone,
  setTimezone,
  seedSettings,
  applyConfigSettings,
} from './settings.js'
import type { Config } from './config.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'osc-settings-'))
  dirs.push(dir)
  return openDb(dir)
}
const cfg = (timezone: string) => ({ site: { timezone } }) as unknown as Config

test('getSetting/setSetting round-trip; missing key → undefined; upsert overwrites', () => {
  const db = freshDb()
  expect(getSetting(db, 'x')).toBeUndefined()
  setSetting(db, 'x', 'y')
  expect(getSetting(db, 'x')).toBe('y')
  setSetting(db, 'x', 'z')
  expect(getSetting(db, 'x')).toBe('z')
})

test('getTimezone defaults to Europe/Stockholm until set', () => {
  const db = freshDb()
  expect(getTimezone(db)).toBe('Europe/Stockholm')
  setTimezone(db, 'America/New_York')
  expect(getTimezone(db)).toBe('America/New_York')
})

test('setTimezone rejects a non-IANA value and leaves the current value intact', () => {
  const db = freshDb()
  expect(() => setTimezone(db, 'Not/AZone')).toThrow(/invalid IANA/)
  expect(getTimezone(db)).toBe('Europe/Stockholm')
})

test('seedSettings seeds a fresh DB but does NOT override an existing (runtime) value', () => {
  const db = freshDb()
  seedSettings(db, cfg('America/New_York'))
  expect(getTimezone(db)).toBe('America/New_York')
  // A later boot with different config must not clobber the persisted value (persist-wins).
  seedSettings(db, cfg('Asia/Tokyo'))
  expect(getTimezone(db)).toBe('America/New_York')
})

test('applyConfigSettings declaratively overwrites (config:apply)', () => {
  const db = freshDb()
  seedSettings(db, cfg('America/New_York'))
  applyConfigSettings(db, cfg('Asia/Tokyo'))
  expect(getTimezone(db)).toBe('Asia/Tokyo')
})
