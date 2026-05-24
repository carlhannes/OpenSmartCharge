import { useSite } from '../hooks/useSite.js'

export default function Tariffs() {
  const site = useSite()

  return (
    <div>
      <h1>Tariffs</h1>
      {!site && <p style={{ color: 'var(--color-muted)' }}>Loading…</p>}
      {site?.tariffs.map((t) => (
        <div key={t.name} style={{ marginBottom: 16, padding: 16, background: 'var(--color-surface)', borderRadius: 'var(--radius)', border: '1px solid var(--color-border)' }}>
          <strong>{t.name}</strong> — {t.type}{t.zone ? ` (${t.zone})` : ''}
        </div>
      ))}
    </div>
  )
}
