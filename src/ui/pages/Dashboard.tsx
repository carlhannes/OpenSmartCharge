import { useLoadpoints } from '../hooks/useLoadpoints.js'
import { useHealth } from '../hooks/useHealth.js'

export default function Dashboard() {
  const loadpoints = useLoadpoints()
  const health = useHealth()

  const worstHealth = Object.values(health).includes('unavailable')
    ? 'unavailable'
    : Object.values(health).includes('degraded')
      ? 'degraded'
      : 'ok'

  return (
    <div>
      <h1>Dashboard</h1>
      <p>
        System: <strong>{worstHealth}</strong> &mdash; {loadpoints.length} loadpoint
        {loadpoints.length !== 1 ? 's' : ''}
        {loadpoints.filter((lp) => lp.charging).length > 0
          ? `, ${loadpoints.filter((lp) => lp.charging).length} charging`
          : ''}
      </p>
    </div>
  )
}
