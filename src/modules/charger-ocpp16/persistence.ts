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
  // Insert the pre-allocated OCPP transaction id as the PRIMARY KEY directly. (This previously
  // inserted with the AUTOINCREMENT rowid then UPDATE'd the id to match — fragile, because the
  // separate `ocpp_tx_counter` sequence could diverge from the AUTOINCREMENT sequence and the
  // UPDATE would then collide with an existing PK or rewrite the wrong row.)
  db.prepare(
    `INSERT INTO transactions
       (id, loadpoint_name, station_id, start_time, id_tag, meter_start)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(transactionId, loadpointName, stationId, params.timestamp, params.idTag, params.meterStart)
}

// Find the id of the currently-open transaction for a station (end_time still NULL), if any.
// Used to rehydrate in-memory transaction state after an OSC restart or a bare charger WS
// reconnect, so live meter values keep flowing to the right session and remoteStop works.
export function findOpenTransaction(db: DatabaseSync, stationId: string): number | undefined {
  const row = db
    .prepare(
      `SELECT id FROM transactions WHERE station_id = ? AND end_time IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(stationId) as { id: number } | undefined
  return row?.id
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

// Close an abandoned open transaction — one whose end_time was never set because a StopTransaction
// was missed (charger reboot / dropped socket) or because the car left while OSC was down. Stamps
// end_time = now and the last recorded session energy so history stays consistent AND
// findOpenTransaction stops re-surfacing it (which would otherwise rehydrate a stale
// activeTransactionId on every reconnect and suppress the next auto-start). No-op if the row is
// unknown or already closed.
export function closeOpenTransaction(db: DatabaseSync, transactionId: number): void {
  const tx = db.prepare(`SELECT end_time FROM transactions WHERE id = ?`).get(transactionId) as
    | { end_time: string | null }
    | undefined
  if (!tx || tx.end_time != null) return
  const energyKwh = latestEnergyKwh(db, transactionId)
  db.prepare(`UPDATE transactions SET end_time = datetime('now'), energy_kwh = ? WHERE id = ?`).run(
    energyKwh,
    transactionId,
  )
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
