// CLI: import osc.yaml into the DB config store (mode: replace), OVERWRITING the runtime config.
//
// The DB is the source of truth: effective config = defaults ⊕ DB (config_overrides + settings +
// loadpoint_state). osc.yaml is an import format — materialized into the DB once on first boot, then
// inert. This command re-asserts osc.yaml onto the DB: it CLEARS the existing config (overrides,
// loadpoint mode/targets, timezone/retention) and re-imports the file — the escape hatch for editing
// osc.yaml after first boot, or resetting runtime tweaks. History/data (transactions, meter samples,
// tariff cache, the Škoda token) is untouched. Restart the server to apply. Run via
// `npm run config:apply`.
import { readConfigDocument, configSchema, CONFIG_PATH, DATA_DIR } from '../core/config.js'
import { openDb } from '../core/db.js'
import { importConfig } from '../core/config-io.js'
import { setConfigMaterialized } from '../core/settings.js'

function main(): void {
  const doc = readConfigDocument(CONFIG_PATH)
  if (!doc) {
    console.error(`No config document found at ${CONFIG_PATH} (nothing to import).`)
    process.exit(1)
  }
  const db = openDb(DATA_DIR)
  try {
    // currentEffective = empty defaults: a replace validates against defaults and only uses it to
    // de-redact secrets (osc.yaml carries plaintext), and a pre-flip DB's partial overrides wouldn't
    // validate over defaults anyway. See materializeConfigOnce.
    const result = importConfig(db, doc, { mode: 'replace', currentEffective: configSchema.parse({}) })
    setConfigMaterialized(db)
    console.log(`Imported ${CONFIG_PATH} → ${DATA_DIR} (replace, clears prior config):`)
    console.log(`  sections: ${result.sections.join(', ') || '(none)'}`)
    console.log(`  Restart the server to apply.`)
  } finally {
    db.close()
  }
}

main()
