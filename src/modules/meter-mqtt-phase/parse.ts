import type { MeterSnapshot } from '../../sdk/meter-reader.js'

export interface PhaseCurrents {
  i1A: number
  i2A: number
  i3A: number
}

/** Which snapshot phase a raw `{prefix}/i{1,2,3}_a` topic carries, or null if it isn't one. */
export function phaseKeyForTopic(topic: string): keyof PhaseCurrents | null {
  if (topic.endsWith('i1_a')) return 'i1A'
  if (topic.endsWith('i2_a')) return 'i2A'
  if (topic.endsWith('i3_a')) return 'i3A'
  return null
}

/**
 * Fold one raw phase-current message into the running per-phase accumulator and return the
 * resulting snapshot. Returns null (accumulator untouched) when the topic isn't a phase topic or
 * the payload isn't a finite number — so a garbage frame never clobbers a good reading.
 */
export function applyPhaseMessage(
  acc: PhaseCurrents,
  topic: string,
  payload: string,
  now: Date,
): MeterSnapshot | null {
  const key = phaseKeyForTopic(topic)
  if (!key) return null
  const val = parseFloat(payload)
  if (!Number.isFinite(val)) return null
  acc[key] = val
  return { i1A: acc.i1A, i2A: acc.i2A, i3A: acc.i3A, timestamp: now }
}
