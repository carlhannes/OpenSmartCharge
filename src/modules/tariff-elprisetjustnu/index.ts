import { registerTariff } from '../../sdk/registry-api.js'
import { createNordpoolDayAheadTariff } from '../../sdk/nordpool-tariff.js'
import { fetchElprisetPrices } from './api.js'

// elprisetjustnu.se — free Swedish day-ahead spot prices (SE1–SE4), 15-minute resolution,
// SEK/kWh, no API key. The Swedish counterpart to the Elering (Baltic/FI) provider; both
// share the Nord Pool schedule/persistence/health orchestration in sdk/nordpool-tariff.
registerTariff({
  type: 'elprisetjustnu',

  create(cfg, ctx) {
    const config = cfg as { name: string; zone: string }
    if (!config.name || !config.zone) {
      throw new Error('tariff-elprisetjustnu: config must have name and zone (SE1–SE4)')
    }
    return createNordpoolDayAheadTariff(ctx, {
      name: config.name,
      zone: config.zone,
      provider: 'elprisetjustnu',
      fetchSlots: fetchElprisetPrices,
    })
  },
})
