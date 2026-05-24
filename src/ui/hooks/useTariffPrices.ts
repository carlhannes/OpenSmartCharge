import { useState, useEffect } from 'react'
import { getTariffPrices, type TariffSlotDto } from '../api/rest.js'
import { subscribe } from '../api/sse.js'

export function useTariffPrices(name: string, from: Date, to: Date) {
  const [slots, setSlots] = useState<TariffSlotDto[]>([])

  useEffect(() => {
    const fetch = () => getTariffPrices(name, from, to).then(setSlots).catch(console.error)
    fetch()

    // Re-fetch when the tariff updates
    const unsub = subscribe('tariff.updated', (d) => {
      if ((d as { name?: string }).name === name) fetch()
    })
    return unsub
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, from.getTime(), to.getTime()])

  return slots
}
