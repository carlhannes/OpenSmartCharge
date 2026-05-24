#!/usr/bin/env node
// Creates an online SQLite backup using VACUUM INTO — safe while OSC is running.
// Usage: node scripts/backup.mjs [--data <dir>] [--out <path>]
//   --data  path to the OSC data directory (default: ./data)
//   --out   destination file (default: ./backups/osc-<timestamp>.db)

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

const dataDir = resolve(arg('--data', './data'))
const dbPath = join(dataDir, 'osc.db')

if (!existsSync(dbPath)) {
  console.error(`Error: database not found at ${dbPath}`)
  console.error('Run OSC at least once to create the database, or use --data <dir> to specify the data directory.')
  process.exit(1)
}

const now = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '')
const outPath = resolve(arg('--out', `./backups/osc-${now}.db`))

mkdirSync(dirname(outPath), { recursive: true })

// VACUUM INTO creates a fully checkpointed copy — safe with WAL mode and concurrent readers.
const db = new DatabaseSync(dbPath)
try {
  db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`)
  console.log(outPath)
} finally {
  db.close()
}
