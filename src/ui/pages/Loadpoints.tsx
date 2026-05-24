import { useState, useEffect } from 'react'
import { getLoadpoints, type LoadpointStateDto } from '../api/rest.js'
import { subscribe } from '../api/sse.js'
import { useSite } from '../hooks/useSite.js'
import LoadpointCard from '../components/LoadpointCard.js'

export default function Loadpoints() {
  const [loadpoints, setLoadpoints] = useState<LoadpointStateDto[]>([])
  const site = useSite()

  useEffect(() => {
    getLoadpoints().then(setLoadpoints).catch(console.error)

    type Patch = Partial<LoadpointStateDto> & { name: string }
    const patch = (u: Patch) =>
      setLoadpoints((prev) => prev.map((lp) => (lp.name === u.name ? { ...lp, ...u } : lp)))

    const unsubState = subscribe('loadpoint.state', (d) => patch(d as Patch))
    const unsubMode = subscribe('loadpoint.mode', (d) => patch(d as Patch))
    const unsubTarget = subscribe('loadpoint.target', (d) => patch(d as Patch))
    return () => { unsubState(); unsubMode(); unsubTarget() }
  }, [])

  const handleUpdate = (updated: LoadpointStateDto) => {
    setLoadpoints((prev) => prev.map((lp) => (lp.name === updated.name ? updated : lp)))
  }

  return (
    <div>
      <h1>Loadpoints</h1>
      {loadpoints.length === 0 && (
        <p style={{ color: 'var(--color-muted)' }}>No loadpoints configured.</p>
      )}
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
        {loadpoints.map((lp) => {
          const siteLp = site?.loadpoints.find((s) => s.name === lp.name)
          const siteCharger = site?.chargers.find((c) => c.name === siteLp?.charger)
          return (
            <LoadpointCard
              key={lp.name}
              lp={lp}
              siteConfig={siteLp}
              // Capability flags: OCPP chargers support all three; others don't
              supportsRemoteStart={siteCharger?.type === 'ocpp16'}
              supportsRemoteStop={siteCharger?.type === 'ocpp16'}
              supportsProfile={siteCharger?.type === 'ocpp16'}
              onUpdate={handleUpdate}
            />
          )
        })}
      </div>
    </div>
  )
}
