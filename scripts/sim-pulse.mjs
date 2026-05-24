#!/usr/bin/env node
// Usage: node scripts/sim-pulse.mjs [host] [port]
// Publishes a recorded DSMR frame to topic 'pulse' every 2s for local testing.
import mqtt from 'mqtt'

const host = process.argv[2] ?? 'localhost'
const port = Number(process.argv[3] ?? 1883)

const FRAME = [
  '/ISK5\\2M550T-1013',
  '',
  '0-0:1.0.0(230101130000W)',
  '1-0:1.7.0(2.345*kW)',
  '1-0:31.7.0(4.2*A)',
  '1-0:51.7.0(3.8*A)',
  '1-0:71.7.0(4.0*A)',
  '!ABCD',
].join('\r\n')

const client = mqtt.connect(`mqtt://${host}:${port}`)

client.on('connect', () => {
  console.log(`sim-pulse: connected to ${host}:${port}, publishing to 'pulse' every 2s`)
  client.publish('pulse', FRAME)
  setInterval(() => {
    client.publish('pulse', FRAME)
  }, 2000)
})

client.on('error', (err) => {
  console.error('sim-pulse: connection error', err.message)
  process.exit(1)
})
