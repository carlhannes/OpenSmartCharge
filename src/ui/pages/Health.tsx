import { useHealth } from '../hooks/useHealth.js'
import type { ModuleHealth } from '../api/rest.js'

const healthColor: Record<ModuleHealth, string> = {
  ok: 'var(--color-ok)',
  degraded: 'var(--color-warn)',
  unavailable: 'var(--color-error)',
}

export default function Health() {
  const health = useHealth()
  const entries = Object.entries(health)

  return (
    <div>
      <h1>Health</h1>
      {entries.length === 0 && <p style={{ color: 'var(--color-muted)' }}>Loading…</p>}
      {entries.map(([id, status]) => (
        <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: healthColor[status], flexShrink: 0 }} />
          <span>{id}</span>
          <span style={{ marginLeft: 'auto', color: healthColor[status], fontSize: '0.875rem' }}>{status}</span>
        </div>
      ))}
    </div>
  )
}
