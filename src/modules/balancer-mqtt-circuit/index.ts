import { registerBalancer } from '../../sdk/registry-api.js'
import type { BalancerModule } from '../../sdk/balancer.js'
import { parseConfig } from './types.js'
import { allocate } from './allocator.js'

// NOTE: the registered type string `mqtt-circuit` is legacy — this balancer no longer connects to
// MQTT or reads the meter. Meter data + staleness are owned by a MeterReader module (the single
// source of truth); the lifecycle resolves the circuit's current budget through the degradation
// ladder and this balancer is a PURE splitter of it. See AGENTS.md → "Declarative config &
// soft-reload" and "Degradation model". Attach live data to a circuit via `balancers[].meterReader`.
const mod: BalancerModule = {
  type: 'mqtt-circuit',
  create(rawCfg) {
    const cfg = parseConfig(rawCfg)
    return {
      id: cfg.name,
      async start() {},
      async stop() {},
      // Pure, stateless allocation math — nothing to be unhealthy about. The "meter feed lost"
      // signal lives on the MeterReader's health(), where the connection actually is.
      health() {
        return 'ok'
      },
      async tick(input) {
        return allocate({ loadpoints: input.loadpoints, circuitBudgetA: input.circuitBudgetA })
      },
    }
  },
}

registerBalancer(mod)
