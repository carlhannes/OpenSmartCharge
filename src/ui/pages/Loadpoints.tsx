import { useLoadpoints } from '../hooks/useLoadpoints.js'

export default function Loadpoints() {
  const loadpoints = useLoadpoints()

  return (
    <div>
      <h1>Loadpoints</h1>
      {loadpoints.length === 0 && <p style={{ color: 'var(--color-muted)' }}>No loadpoints configured.</p>}
      {loadpoints.map((lp) => (
        <div key={lp.name} style={{ marginBottom: 16, padding: 16, background: 'var(--color-surface)', borderRadius: 'var(--radius)', border: '1px solid var(--color-border)' }}>
          <strong>{lp.name}</strong> — {lp.mode} — {lp.connected ? 'connected' : 'disconnected'} — {lp.currentA.toFixed(1)} A
        </div>
      ))}
    </div>
  )
}
