import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useBalancer } from '../hooks/useBalancer.js'
import styles from './BalancerCard.module.css'

interface Props {
  name: string
  mainBreakerA: number
}

export default function BalancerCard({ name, mainBreakerA }: Props) {
  const state = useBalancer(name)

  const alloc = state?.lastAllocations
  const allocData = alloc
    ? Object.entries(alloc).map(([id, amps]) => ({ id, amps }))
    : []

  const healthColor =
    state?.health === 'ok' ? 'var(--color-ok)'
    : state?.health === 'degraded' ? 'var(--color-warn)'
    : 'var(--color-error)'

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.name}>{name}</span>
        <span style={{ color: healthColor, fontSize: '0.8rem' }}>{state?.health ?? '…'}</span>
      </div>

      <div className={styles.freeAmps}>
        <span className={styles.freeLabel}>Free headroom</span>
        <span className={styles.freeValue}>{state?.freeAmps != null ? `${state.freeAmps} A` : '—'}</span>
        <span className={styles.breaker}>/ {mainBreakerA} A breaker</span>
      </div>

      {allocData.length > 0 && (
        <ResponsiveContainer width="100%" height={120}>
          <BarChart data={allocData} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }}>
            <XAxis type="number" domain={[0, mainBreakerA]} tick={{ fontSize: 10, fill: 'var(--color-muted)' }} />
            <YAxis type="category" dataKey="id" tick={{ fontSize: 10, fill: 'var(--color-muted)' }} width={80} />
            <Tooltip
              contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6 }}
              formatter={(v) => [`${v as number} A`, 'Allocation']}
            />
            <Bar dataKey="amps" fill="var(--color-accent)" radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
      {allocData.length === 0 && <p style={{ color: 'var(--color-muted)', fontSize: '0.875rem' }}>No allocations yet.</p>}
    </div>
  )
}
