import { test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { loadLoadpointStates } from './loadpoint.js'

test('defaultMode seeds a new loadpoint; a persisted mode wins on restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lp-'))
  const db = openDb(dir)
  try {
    // First boot: the configured defaultMode is honored (not hardcoded 'smart').
    let states = loadLoadpointStates(db, [{ name: 'lp', defaultMode: 'disabled' }])
    expect(states.get('lp')?.mode).toBe('disabled')

    // Restart with a different defaultMode must NOT override the persisted mode.
    states = loadLoadpointStates(db, [{ name: 'lp', defaultMode: 'fast' }])
    expect(states.get('lp')?.mode).toBe('disabled')

    // No defaultMode → still defaults to 'smart'.
    states = loadLoadpointStates(db, [{ name: 'other' }])
    expect(states.get('other')?.mode).toBe('smart')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
