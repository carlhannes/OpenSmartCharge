import { registerTariff } from '../../sdk/registry-api.js'
import { createNordpoolDayAheadTariff } from '../../sdk/nordpool-tariff.js'
import { fetchEleringPrices } from './api.js'

// Elering (Estonian TSO) day-ahead prices for the Baltic + Finland zones:
// EE, FI, LV, LT. For Swedish zones (SE1–SE4), use the `elprisetjustnu` provider.
// All the schedule/persistence/health orchestration is shared — this module only
// supplies the provider-specific fetch.
registerTariff({
  type: 'elering',

  create(cfg, ctx) {
    const config = cfg as { name: string; zone: string }
    if (!config.name || !config.zone) {
      throw new Error('tariff-elering: config must have name and zone (EE | FI | LV | LT)')
    }
    return createNordpoolDayAheadTariff(ctx, {
      name: config.name,
      zone: config.zone,
      provider: 'Elering',
      fetchSlots: fetchEleringPrices,
    })
  },
})
