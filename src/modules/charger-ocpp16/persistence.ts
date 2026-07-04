import type { DatabaseSync } from 'node:sqlite'
import type { StartTransactionReq, StopTransactionReq, MeterValuesReq } from './types.js'
import { parseMeterValue } from './meter-parser.js'

export function allocateTransactionId(db: DatabaseSync): number {
  const row = db.prepare(`SELECT next_value FROM ocpp_tx_counter WHERE id = 1`).get() as
    | { next_value: number }
    | undefined
  const id = row?.next_value ?? 1
  db.prepare(`UPDATE ocpp_tx_counter SET next_value = ? WHERE id = 1`).run(id + 1)
  return id
}

export function insertTransaction(
  db: DatabaseSync,
  loadpointName: string,
  stationId: string,
  transactionId: number,
  params: StartTransactionReq,
): void {
  db.prepare(
    `INSERT INTO transactions
       (loadpoint_name, station_id, start_time, id_tag, meter_start)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(loadpointName, stationId, params.timestamp, params.idTag, params.meterStart)
  // Store the OCPP tx id in a mapping row — we re-use the rowid implicitly,
  // but we need to find this transaction later by OCPP transactionId.
  // Simplest: update the row we just inserted with the OCPP id.
  db.prepare(
    `UPDATE transactions SET id = ? WHERE loadpoint_name = ? AND start_time = ? AND id_tag = ?`,
  ).run(transactionId, loadpointName, params.timestamp, params.idTag)
}

export function finishTransaction(
  db: DatabaseSync,
  transactionId: number,
  params: StopTransactionReq,
): void {
  // Session energy = (meterStop − meterStart)/1000; both registers are Wh. Falls back to the
  // absolute register if meterStart is unknown (older rows).
  const tx = db.prepare(`SELECT meter_start FROM transactions WHERE id = ?`).get(transactionId) as
    | { meter_start: number | null }
    | undefined
  const startWh = tx?.meter_start ?? 0
  const energyKwh = (params.meterStop - startWh) / 1000
  db.prepare(
    `UPDATE transactions
       SET end_time = ?, energy_kwh = ?
     WHERE id = ?`,
  ).run(params.timestamp, energyKwh, transactionId)
}

export function insertMeterValues(
  db: DatabaseSync,
  transactionId: number | undefined,
  params: MeterValuesReq,
): void {
  if (!transactionId) return

  const stmt = db.prepare(
    `INSERT INTO meter_values (transaction_id, measured_at, energy_kwh, power_w, current_a, voltage_v, soc, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const mv of params.meterValue) {
    const parsed = parseMeterValue(mv)
    stmt.run(
      transactionId,
      mv.timestamp,
      parsed.energyKwh ?? null,
      parsed.powerW ?? null,
      parsed.currentA ?? null,
      parsed.voltageV ?? null,
      parsed.socPct ?? null,
      JSON.stringify(mv),
    )
  }
}

export function latestEnergyKwh(db: DatabaseSync, transactionId: number): number {
  const row = db
    .prepare(
      `SELECT energy_kwh FROM meter_values WHERE transaction_id = ? AND energy_kwh IS NOT NULL ORDER BY measured_at DESC LIMIT 1`,
    )
    .get(transactionId) as { energy_kwh: number } | undefined
  if (!row) return 0
  // Report the session delta, not the charger's lifetime register. meter_values.energy_kwh is
  // the absolute register (kWh); transactions.meter_start is Wh.
  const tx = db.prepare(`SELECT meter_start FROM transactions WHERE id = ?`).get(transactionId) as
    | { meter_start: number | null }
    | undefined
  const startKwh = tx?.meter_start != null ? tx.meter_start / 1000 : 0
  return Math.max(0, row.energy_kwh - startKwh)
}
