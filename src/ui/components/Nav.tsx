import { NavLink } from 'react-router-dom'
import styles from './Nav.module.css'

const links = [
  { to: '/', label: 'Dashboard' },
  { to: '/loadpoints', label: 'Loadpoints' },
  { to: '/tariffs', label: 'Tariffs' },
  { to: '/balancers', label: 'Balancers' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/health', label: 'Health' },
]

export default function Nav() {
  return (
    <nav className={styles.nav}>
      <span className={styles.brand}>OpenSmartCharge</span>
      <ul className={styles.links}>
        {links.map(({ to, label }) => (
          <li key={to}>
            <NavLink to={to} end={to === '/'} className={({ isActive }) => isActive ? styles.active : undefined}>
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
