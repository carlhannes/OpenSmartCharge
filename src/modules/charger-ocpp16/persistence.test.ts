import { test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../core/db.js'
import {
  allocateTransactionId,
  insertTransaction,
  finishTransaction,
  insertMeterValues,
  latestEnergyKwh,
  findOpenTransaction,
} from './persistence.js'
import type { StartTransactionReq, MeterValuesReq } from './types.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'osc-persist-test-'))
  dirs.push(dir)
  return openDb(dir)
}
const start = (meterStart: number, timestamp: string): StartTransactionReq => ({
  connectorId: 1,
  idTag: 'tag',
  meterStart,
  timestamp,
})

test('insertTransaction stores the pre-allocated OCPP id as the primary key (no remap)', () => {
  const db = freshDb()
  const id = allocateTransactionId(db)
  insertTransaction(db, 'lp1', 'STN1', id, start(1000, '2026-07-04T10:00:00Z'))
  const row = db
    .prepare('SELECT id, station_id, meter_start, end_time FROM transactions')
    .get() as {
    id: number
    station_id: string
    meter_start: number
    end_time: string | null
  }
  expect(row.id).toBe(id)
  expect(row.station_id).toBe('STN1')
  expect(row.meter_start).toBe(1000)
  expect(row.end_time).toBeNull()
})

test('consecutive allocations get distinct ids and both persist (no PK collision)', () => {
  const db = freshDb()
  const a = allocateTransactionId(db)
  insertTransaction(db, 'lp1', 'STN1', a, start(0, '2026-07-04T10:00:00Z'))
  const b = allocateTransactionId(db)
  insertTransaction(db, 'lp1', 'STN1', b, start(0, '2026-07-04T10:01:00Z'))
  expect(b).toBe(a + 1)
  const ids = (
    db.prepare('SELECT id FROM transactions ORDER BY id').all() as Array<{ id: number }>
  ).map((r) => r.id)
  expect(ids).toEqual([a, b])
})

test('findOpenTransaction returns the open tx, undefined for other stations, undefined once finished', () => {
  const db = freshDb()
  const id = allocateTransactionId(db)
  insertTransaction(db, 'lp1', 'STN1', id, start(0, '2026-07-04T10:00:00Z'))
  expect(findOpenTransaction(db, 'STN1')).toBe(id)
  expect(findOpenTransaction(db, 'OTHER')).toBeUndefined()
  finishTransaction(db, id, {
    transactionId: id,
    meterStop: 5000,
    timestamp: '2026-07-04T11:00:00Z',
  })
  expect(findOpenTransaction(db, 'STN1')).toBeUndefined()
})

test('latestEnergyKwh reports the session delta from meterStart', () => {
  const db = freshDb()
  const id = allocateTransactionId(db)
  insertTransaction(db, 'lp1', 'STN1', id, start(1_000_000, '2026-07-04T10:00:00Z'))
  const mv: MeterValuesReq = {
    connectorId: 1,
    transactionId: id,
    meterValue: [
      {
        timestamp: '2026-07-04T10:05:00Z',
        sampledValue: [
          { value: '1002500', measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
        ],
      },
    ],
  }
  insertMeterValues(db, id, mv)
  expect(latestEnergyKwh(db, id)).toBeCloseTo(2.5, 3) // (1_002_500 − 1_000_000)/1000
})
