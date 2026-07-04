import { useHealth } from '../hooks/useHealth.js'
import HealthBadge from '../components/HealthBadge.js'
import type { ModuleHealth } from '../client/rest.js'
import styles from './Health.module.css'

export default function Health() {
  const health = useHealth()
  const entries = Object.entries(health) as [string, ModuleHealth][]

  return (
    <div>
      <h1>Health</h1>
      {entries.length === 0 && <p style={{ color: 'var(--color-muted)' }}>Loading…</p>}
      <div className={styles.list}>
        {entries.map(([id, status]) => (
          <div key={id} className={styles.row}>
            <HealthBadge health={status} size={10} />
            <span className={styles.id}>{id}</span>
            <span className={styles.status} data-status={status}>
              {status}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
