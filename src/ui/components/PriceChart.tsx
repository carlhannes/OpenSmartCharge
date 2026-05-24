import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import type { TariffSlotDto } from '../api/rest.js'

interface Props {
  slots: TariffSlotDto[]
  currency: string
}

export default function PriceChart({ slots, currency }: Props) {
  if (slots.length === 0) return <p style={{ color: 'var(--color-muted)' }}>No price data available.</p>

  const now = Date.now()
  const data = slots.map((s) => ({
    label: new Date(s.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    price: s.pricePerKWh,
    isCurrent: new Date(s.start).getTime() <= now && new Date(s.end).getTime() > now,
  }))

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--color-muted)' }} interval="preserveStartEnd" />
        <YAxis
          tick={{ fontSize: 10, fill: 'var(--color-muted)' }}
          tickFormatter={(v: number) => `${v.toFixed(2)}`}
          width={45}
        />
        <Tooltip
          contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6 }}
          labelStyle={{ color: 'var(--color-text)' }}
          formatter={(v) => [`${(v as number).toFixed(4)} ${currency}/kWh`, 'Price']}
        />
        <Bar dataKey="price" radius={[3, 3, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.isCurrent ? 'var(--color-accent)' : 'var(--color-border)'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
