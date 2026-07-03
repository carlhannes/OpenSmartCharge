import { useSite } from '../hooks/useSite.js'
import { useTariffPrices } from '../hooks/useTariffPrices.js'
import PriceChart from '../components/PriceChart.js'
import styles from './Tariffs.module.css'

const now = new Date()
const to = new Date(now.getTime() + 48 * 3_600_000)

function TariffPanel({ name, zone }: { name: string; zone?: string }) {
  const slots = useTariffPrices(name, now, to)
  const currency = slots[0]?.currency ?? '—'

  return (
    <div className={styles.panel}>
      <h2>
        {name}
        {zone ? <span className={styles.zone}> ({zone})</span> : null}
      </h2>
      <p className={styles.meta}>
        {slots.length} slots · {currency}
      </p>
      <PriceChart slots={slots} currency={currency} />
    </div>
  )
}

export default function Tariffs() {
  const site = useSite()

  return (
    <div>
      <h1>Tariffs</h1>
      {!site && <p style={{ color: 'var(--color-muted)' }}>Loading…</p>}
      {site?.tariffs.length === 0 && (
        <p style={{ color: 'var(--color-muted)' }}>No tariffs configured.</p>
      )}
      {site?.tariffs.map((t) => (
        <TariffPanel key={t.name} name={t.name} zone={t.zone} />
      ))}
    </div>
  )
}
