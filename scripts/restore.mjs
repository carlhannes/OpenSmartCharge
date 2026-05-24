#!/usr/bin/env node
// Restores an OSC database from a backup file.
// Usage: node scripts/restore.mjs --in <backup.db> [--data <dir>] [--force]
//   --in    path to the backup file (required)
//   --data  path to the OSC data directory (default: ./data)
//   --force skip the "OSC is running" WAL-file safety check

import { copyFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

const inPath = resolve(arg('--in', ''))
const dataDir = resolve(arg('--data', './data'))
const force = args.includes('--force')

if (!inPath) {
  console.error('Usage: node scripts/restore.mjs --in <backup.db> [--data <dir>] [--force]')
  process.exit(1)
}

if (!existsSync(inPath)) {
  console.error(`Error: backup file not found: ${inPath}`)
  process.exit(1)
}

const walPath = join(dataDir, 'osc.db-wal')
const shmPath = join(dataDir, 'osc.db-shm')

if (!force && (existsSync(walPath) || existsSync(shmPath))) {
  console.error('Error: OSC appears to be running (WAL files present in data directory).')
  console.error('Stop OSC first, then run restore. Use --force to skip this check.')
  process.exit(1)
}

const destPath = join(dataDir, 'osc.db')
copyFileSync(inPath, destPath)
console.log(`Restored: ${inPath} → ${destPath}`)
