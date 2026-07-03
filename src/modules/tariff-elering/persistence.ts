import type { DatabaseSync } from 'node:sqlite'
import type { TariffSlot } from '../../sdk/tariff.js'

export function upsertSlots(db: DatabaseSync, zone: string, slots: TariffSlot[]): void {
  if (slots.length === 0) return
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO tariff_slots (zone, slot_start, slot_end, price_per_kwh, currency)
     VALUES (?, ?, ?, ?, ?)`,
  )
  db.exec('BEGIN')
  for (const slot of slots) {
    stmt.run(
      zone,
      slot.start.toISOString(),
      slot.end.toISOString(),
      slot.pricePerKWh,
      slot.currency,
    )
  }
  db.exec('COMMIT')
}

export function getSlots(db: DatabaseSync, zone: string, from: Date, to: Date): TariffSlot[] {
  const rows = db
    .prepare(
      `SELECT slot_start, slot_end, price_per_kwh, currency
       FROM tariff_slots
       WHERE zone = ? AND slot_start >= ? AND slot_start < ?
       ORDER BY slot_start`,
    )
    .all(zone, from.toISOString(), to.toISOString()) as {
    slot_start: string
    slot_end: string
    price_per_kwh: number
    currency: string
  }[]

  return rows.map((r) => ({
    start: new Date(r.slot_start),
    end: new Date(r.slot_end),
    pricePerKWh: r.price_per_kwh,
    currency: r.currency,
  }))
}

// Returns the latest slot_end we have cached for the given zone, or null if empty.
export function latestSlotEnd(db: DatabaseSync, zone: string): Date | null {
  const row = db
    .prepare(`SELECT MAX(slot_end) AS max_end FROM tariff_slots WHERE zone = ?`)
    .get(zone) as { max_end: string | null }
  return row.max_end ? new Date(row.max_end) : null
}
