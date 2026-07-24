import { useState, useEffect } from 'react'
import { getLoadpoints, type LoadpointStateDto } from '../client/rest.js'
import { subscribe } from '../client/sse.js'

export function useLoadpoints() {
  const [loadpoints, setLoadpoints] = useState<LoadpointStateDto[]>([])

  useEffect(() => {
    getLoadpoints().then(setLoadpoints).catch(console.error)

    type Patch = Partial<LoadpointStateDto> & { name: string }
    const patch = (u: Patch) =>
      setLoadpoints((prev) => prev.map((lp) => (lp.name === u.name ? { ...lp, ...u } : lp)))

    const unsubState = subscribe('loadpoint.state', (d) => patch(d as Patch))
    const unsubMode = subscribe('loadpoint.mode', (d) => patch(d as Patch))
    const unsubTarget = subscribe('loadpoint.target', (d) => patch(d as Patch))

    return () => {
      unsubState()
      unsubMode()
      unsubTarget()
    }
  }, [])

  return loadpoints
}
