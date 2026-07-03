import { NavLink } from 'react-router-dom'
import { useHealth } from '../hooks/useHealth.js'
import HealthBadge from './HealthBadge.js'
import type { ModuleHealth } from '../api/rest.js'
import styles from './Nav.module.css'

function worstHealth(health: Record<string, ModuleHealth>): ModuleHealth {
  const values = Object.values(health)
  if (values.includes('unavailable')) return 'unavailable'
  if (values.includes('degraded')) return 'degraded'
  return values.length > 0 ? 'ok' : 'ok'
}

const links = [
  { to: '/', label: 'Dashboard' },
  { to: '/loadpoints', label: 'Loadpoints' },
  { to: '/tariffs', label: 'Tariffs' },
  { to: '/balancers', label: 'Balancers' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/health', label: 'Health' },
]

export default function Nav() {
  const health = useHealth()
  const overall = worstHealth(health)

  return (
    <nav className={styles.nav}>
      <span className={styles.brand}>OpenSmartCharge</span>
      <ul className={styles.links}>
        {links.map(({ to, label }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={to === '/'}
              className={({ isActive }) => (isActive ? styles.active : undefined)}
            >
              {label}
              {to === '/health' && Object.keys(health).length > 0 && (
                <span style={{ marginLeft: 5, verticalAlign: 'middle' }}>
                  <HealthBadge health={overall} size={7} />
                </span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
