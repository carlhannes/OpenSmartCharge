import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { createLogger } from './logger.js'
import { loadPlugins } from './plugin-loader.js'
import { loadLoadpointStates } from './loadpoint.js'
import { createEventBus } from './events.js'
import { createHealthMap } from './health.js'

const CONFIG_PATH = process.env.OSC_CONFIG ?? './osc.yaml'
const DATA_DIR = process.env.OSC_DATA_DIR ?? './data'
const PLUGINS_DIR = process.env.OSC_PLUGINS_DIR ?? './plugins'

async function main() {
  const log = createLogger()
  log.info('OpenSmartCharge starting')

  const config = loadConfig(CONFIG_PATH)
  log.info({ site: config.site.name, port: config.site.port }, 'config loaded')

  const db = openDb(DATA_DIR)
  log.info({ dataDir: DATA_DIR }, 'database ready')

  const events = createEventBus()
  const health = createHealthMap()

  await loadPlugins(PLUGINS_DIR, log)

  const loadpointNames = config.loadpoints.map((lp) => lp.name)
  const loadpointStates = loadLoadpointStates(db, loadpointNames)
  log.info({ loadpoints: [...loadpointStates.keys()] }, 'loadpoints initialized')

  // Module instantiation, server, and balancer loop wired in M1
  log.info('ready — modules will be wired in Milestone 1')

  const shutdown = () => {
    log.info('shutting down gracefully')
    db.close()
    process.exit(0)
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  // Keep process alive (server will replace this in M1)
  void events
  void health
}

main().catch((err) => {
  console.error('fatal startup error', err)
  process.exit(1)
})
