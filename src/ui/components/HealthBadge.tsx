import type { ModuleHealth } from '../client/rest.js'

const colors: Record<ModuleHealth, string> = {
  ok: 'var(--color-ok)',
  degraded: 'var(--color-warn)',
  unavailable: 'var(--color-error)',
}

interface Props {
  health: ModuleHealth
  size?: number
}

export default function HealthBadge({ health, size = 8 }: Props) {
  return (
    <span
      title={health}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: colors[health],
        flexShrink: 0,
      }}
    />
  )
}
