// CLI: declaratively apply osc.yaml's loadpoint defaults (mode + targets) into the persisted DB,
// OVERWRITING the runtime state. At runtime the DB is the source of truth — changes made via the
// UI/API/MQTT persist and win on restart (see loadLoadpointStates' persist-wins seeding). This
// command is the deliberate escape hatch: run it to re-assert osc.yaml onto the DB (e.g. after
// editing the file, or to reset runtime tweaks). Resolves the same OSC_CONFIG / OSC_DATA_DIR as
// the server. Run via `npm run config:apply`.
import { loadConfig, CONFIG_PATH, DATA_DIR } from '../core/config.js'
import { openDb } from '../core/db.js'
import { configToLoadpointInits, applyConfigToLoadpoints } from '../core/loadpoint.js'
import { applyConfigSettings, getTimezone } from '../core/settings.js'
import { applyConfigOverrides } from '../core/config-overrides.js'

interface StateRow {
  mode: string
  target_soc: number | null
  target_time: string | null
  target_kwh: number | null
}

function main(): void {
  const prune = process.argv.includes('--prune')
  const config = loadConfig(CONFIG_PATH)
  const db = openDb(DATA_DIR)
  try {
    const inits = configToLoadpointInits(config)
    const stmt = db.prepare(
      'SELECT mode, target_soc, target_time, target_kwh FROM loadpoint_state WHERE name = ?',
    )
    const read = (name: string): StateRow | undefined => stmt.get(name) as StateRow | undefined
    const before = new Map(inits.map((i) => [i.name, read(i.name)]))

    applyConfigSettings(db, config)
    applyConfigToLoadpoints(db, inits)
    // Re-assert structural config: clear overrides for entities the file defines; preserve
    // runtime-added ones (claimed chargers / added vehicles) unless --prune.
    const { cleared, preserved } = applyConfigOverrides(config, db, { prune })

    console.log(`Applied ${CONFIG_PATH} → ${DATA_DIR}:`)
    console.log(`  settings.timezone → ${getTimezone(db)}`)
    console.log(`  ${inits.length} loadpoint(s):`)
    for (const i of inits) {
      console.log(
        `  ${i.name}: ${JSON.stringify(before.get(i.name) ?? null)} → ${JSON.stringify(read(i.name) ?? null)}`,
      )
    }
    console.log(
      `  config overrides: cleared ${cleared.length}, preserved ${preserved.length}${prune ? ' (--prune)' : ''}`,
    )
    for (const o of preserved) console.log(`    preserved (runtime-added): ${o.kind}/${o.name}`)
  } finally {
    db.close()
  }
}

main()
