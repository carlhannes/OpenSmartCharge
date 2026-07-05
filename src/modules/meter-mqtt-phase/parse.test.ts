import { describe, it, expect } from 'vitest'
import { phaseKeyForTopic, applyPhaseMessage, type PhaseCurrents } from './parse.js'

describe('phaseKeyForTopic', () => {
  it('maps the three raw phase topics', () => {
    expect(phaseKeyForTopic('house/i1_a')).toBe('i1A')
    expect(phaseKeyForTopic('house/i2_a')).toBe('i2A')
    expect(phaseKeyForTopic('house/i3_a')).toBe('i3A')
  })
  it('returns null for anything else', () => {
    expect(phaseKeyForTopic('house/power_w')).toBeNull()
    expect(phaseKeyForTopic('house/i4_a')).toBeNull()
  })
})

describe('applyPhaseMessage', () => {
  const now = new Date('2026-01-01T12:00:00Z')

  it('folds each phase into a full snapshot, carrying prior phases forward', () => {
    const acc: PhaseCurrents = { i1A: 0, i2A: 0, i3A: 0 }
    const s1 = applyPhaseMessage(acc, 'house/i1_a', '10.5', now)
    expect(s1).toEqual({ i1A: 10.5, i2A: 0, i3A: 0, timestamp: now })
    const s2 = applyPhaseMessage(acc, 'house/i2_a', '8', now)
    expect(s2).toEqual({ i1A: 10.5, i2A: 8, i3A: 0, timestamp: now })
    const s3 = applyPhaseMessage(acc, 'house/i3_a', '3.2', now)
    expect(s3).toEqual({ i1A: 10.5, i2A: 8, i3A: 3.2, timestamp: now })
  })

  it('ignores non-phase topics and non-finite payloads without clobbering the accumulator', () => {
    const acc: PhaseCurrents = { i1A: 10, i2A: 10, i3A: 10 }
    expect(applyPhaseMessage(acc, 'house/power_w', '999', now)).toBeNull()
    expect(applyPhaseMessage(acc, 'house/i1_a', 'NaN', now)).toBeNull()
    expect(applyPhaseMessage(acc, 'house/i1_a', '', now)).toBeNull()
    expect(acc).toEqual({ i1A: 10, i2A: 10, i3A: 10 })
  })
})
