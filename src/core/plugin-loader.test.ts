import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { loadPlugins } from './plugin-loader.js'
import { getTariffModule } from '../sdk/registry-api.js'

test('an async plugin has finished registering by the time loadPlugins resolves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-plugins-'))
  try {
    // Registers only after an await — the lifecycle instantiates modules right after loadPlugins, so
    // a fire-and-forget call would leave this type unknown at boot.
    writeFileSync(
      join(dir, 'late.js'),
      `export default async function (api) {
         await new Promise((r) => setTimeout(r, 20))
         api.registerTariff({ type: 'late-test-tariff', create: () => ({}) })
       }`,
    )
    await loadPlugins(dir, pino({ level: 'silent' }))
    expect(getTariffModule('late-test-tariff')).toBeDefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
