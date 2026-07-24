import { useState, useEffect } from 'react'
import { getBalancer, type BalancerStateDto } from '../client/rest.js'
import { subscribe } from '../client/sse.js'

export function useBalancer(name: string) {
  const [state, setState] = useState<BalancerStateDto | null>(null)

  useEffect(() => {
    getBalancer(name).then(setState).catch(console.error)

    const unsub = subscribe('balancer.tick', (d) => {
      const tick = d as {
        name: string
        allocations: Record<string, number>
        freeAmps: number
        health: string
      }
      if (tick.name === name) {
        setState({
          name,
          health: tick.health as BalancerStateDto['health'],
          lastAllocations: tick.allocations,
          freeAmps: tick.freeAmps,
        })
      }
    })
    return unsub
  }, [name])

  return state
}
