import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Logger } from 'pino'
import {
  registerCharger,
  registerTariff,
  registerBalancer,
  registerVehicle,
} from '../sdk/registry-api.js'

// Passed to each plugin's default export so plugins don't need to resolve OSC's location
const pluginApi = { registerCharger, registerTariff, registerBalancer, registerVehicle }

export async function loadPlugins(dir: string, log: Logger): Promise<void> {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.js'))
  } catch {
    log.debug({ dir }, 'plugins directory not found — skipping')
    return
  }

  if (files.length === 0) {
    log.debug({ dir }, 'no plugins found')
    return
  }

  for (const file of files) {
    const path = resolve(join(dir, file))
    try {
      const mod = await import(pathToFileURL(path).href)
      if (typeof mod.default === 'function') {
        mod.default(pluginApi)
        log.info({ plugin: file }, 'plugin loaded')
      } else {
        log.warn({ plugin: file }, 'plugin skipped — no default export function')
      }
    } catch (err) {
      log.error({ plugin: file, err }, 'plugin failed to load')
    }
  }
}
