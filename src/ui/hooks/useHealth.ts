import { useState, useEffect } from 'react'
import { getHealth, type ModuleHealth } from '../client/rest.js'

export function useHealth() {
  const [health, setHealth] = useState<Record<string, ModuleHealth>>({})

  useEffect(() => {
    const fetch = () => getHealth().then(setHealth).catch(console.error)
    fetch()
    // Poll every 15 s — health has no dedicated SSE event, it's derived from module ticks
    const interval = setInterval(fetch, 15_000)
    return () => clearInterval(interval)
  }, [])

  return health
}
