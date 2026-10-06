#!/usr/bin/env node
// Restores an OSC database from a backup file.
// Usage: node scripts/restore.mjs --in <backup.db> [--data <dir>] [--force]
//   --in    path to the backup file (required)
//   --data  path to the OSC data directory (default: $OSC_DATA_DIR, else ./data — same as the server)
//   --force skip the "OSC is running" WAL-file safety check (stale -wal/-shm files are then removed:
//           they belong to the OLD database and must not be replayed onto the restored one)

import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

const inArg = arg('--in')
// Checked before resolve(): resolve('') is the current directory, which would slip past the check.
if (!inArg) {
  console.error('Usage: node scripts/restore.mjs --in <backup.db> [--data <dir>] [--force]')
  process.exit(1)
}
const inPath = resolve(inArg)
const dataDir = resolve(arg('--data', process.env.OSC_DATA_DIR ?? './data'))
const force = args.includes('--force')

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
rmSync(walPath, { force: true })
rmSync(shmPath, { force: true })
console.log(`Restored: ${inPath} → ${destPath}`)
