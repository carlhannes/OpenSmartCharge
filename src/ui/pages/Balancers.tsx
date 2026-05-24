import { useSite } from '../hooks/useSite.js'
import { useBalancer } from '../hooks/useBalancer.js'

function BalancerRow({ name }: { name: string }) {
  const state = useBalancer(name)
  return (
    <div style={{ marginBottom: 16, padding: 16, background: 'var(--color-surface)', borderRadius: 'var(--radius)', border: '1px solid var(--color-border)' }}>
      <strong>{name}</strong> — {state?.health ?? '…'} — free: {state?.freeAmps != null ? `${state.freeAmps} A` : '…'}
    </div>
  )
}

export default function Balancers() {
  const site = useSite()

  return (
    <div>
      <h1>Balancers</h1>
      {!site && <p style={{ color: 'var(--color-muted)' }}>Loading…</p>}
      {site?.balancers.map((b) => <BalancerRow key={b.name} name={b.name} />)}
    </div>
  )
}
