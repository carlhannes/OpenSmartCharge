import { useLoadpoints } from '../hooks/useLoadpoints.js'
import { useHealth } from '../hooks/useHealth.js'
import { useSite } from '../hooks/useSite.js'
import HealthBadge from '../components/HealthBadge.js'
import type { ModuleHealth } from '../api/rest.js'
import styles from './Dashboard.module.css'

function worstHealth(health: Record<string, ModuleHealth>): ModuleHealth {
  const values = Object.values(health)
  if (values.includes('unavailable')) return 'unavailable'
  if (values.includes('degraded')) return 'degraded'
  return 'ok'
}

export default function Dashboard() {
  const loadpoints = useLoadpoints()
  const health = useHealth()
  const site = useSite()
  const overall = worstHealth(health)

  const connected = loadpoints.filter((lp) => lp.connected)
  const charging = loadpoints.filter((lp) => lp.charging)
  const totalA = charging.reduce((s, lp) => s + lp.currentA, 0)

  return (
    <div>
      <h1>{site?.site.name ?? 'OpenSmartCharge'}</h1>
      <div className={styles.cards}>
        <div className={styles.card}>
          <span className={styles.cardLabel}>System health</span>
          <span className={styles.cardValue} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <HealthBadge health={overall} size={12} />
            {overall}
          </span>
        </div>
        <div className={styles.card}>
          <span className={styles.cardLabel}>Charging</span>
          <span className={styles.cardValue}>{charging.length} / {loadpoints.length}</span>
        </div>
        <div className={styles.card}>
          <span className={styles.cardLabel}>Total current</span>
          <span className={styles.cardValue}>{totalA.toFixed(1)} A</span>
        </div>
        <div className={styles.card}>
          <span className={styles.cardLabel}>Connected</span>
          <span className={styles.cardValue}>{connected.length} vehicle{connected.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
    </div>
  )
}
