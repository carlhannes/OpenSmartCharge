import { z } from 'zod'
import mqtt, { type MqttClient } from 'mqtt'

// One shared shape for "connect to this MQTT broker", reused by every MQTT-speaking module (meter
// readers on the inbound side, the OSC bridge on the outbound side). Keeping it here — not in a global
// `mqtt:` block — is deliberate: reading a meter and OSC publishing its own data are separate concerns,
// each carrying its own broker so one can exist without the other.
export const brokerSchema = z.object({
  host: z.string(),
  port: z.number().default(1883),
  user: z.string().optional(),
  password: z.string().optional(),
})

export type Broker = z.infer<typeof brokerSchema>

/** Open a connection to `broker`. One mapping from the shared config shape to the mqtt client options. */
export function connectBroker(broker: Broker, clientIdPrefix: string): MqttClient {
  return mqtt.connect({
    host: broker.host,
    port: broker.port,
    username: broker.user,
    password: broker.password,
    clientId: `${clientIdPrefix}-${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
  })
}

/** Close cleanly (sends DISCONNECT) and resolve once done; a never-opened client resolves at once. */
export function endBroker(client: MqttClient | null | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (client) client.end(false, {}, () => resolve())
    else resolve()
  })
}

/**
 * Parse a per-module `broker: {...}` block from raw (catchall) config. Throws a descriptive Error —
 * caught at startup and logged — when it's missing/invalid so a misconfigured module fails loudly at
 * boot rather than silently never connecting.
 */
export function parseBroker(raw: unknown, moduleName: string): Broker {
  const result = brokerSchema.safeParse(raw)
  if (!result.success) {
    throw new Error(
      `${moduleName}: invalid or missing 'broker' config (need at least broker.host) — ${result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    )
  }
  return result.data
}
