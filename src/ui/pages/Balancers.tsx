import { useSite } from '../hooks/useSite.js'
import BalancerCard from '../components/BalancerCard.js'

export default function Balancers() {
  const site = useSite()

  return (
    <div>
      <h1>Balancers</h1>
      {!site && <p style={{ color: 'var(--color-muted)' }}>Loading…</p>}
      {site?.balancers.length === 0 && <p style={{ color: 'var(--color-muted)' }}>No balancers configured.</p>}
      {site?.balancers.map((b) => (
        <BalancerCard key={b.name} name={b.name} mainBreakerA={b.mainBreakerA} />
      ))}
    </div>
  )
}
