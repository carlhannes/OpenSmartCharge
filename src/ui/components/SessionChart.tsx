import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import type { MeterSampleDto } from '../client/rest.js'

interface Props {
  samples: MeterSampleDto[]
}

export default function SessionChart({ samples }: Props) {
  if (samples.length === 0)
    return <p style={{ color: 'var(--color-muted)' }}>No meter data for this session.</p>

  const data = samples.map((s) => ({
    t: new Date(s.measured_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    power: s.power_w != null ? Math.round(s.power_w) : null,
    current: s.current_a != null ? Math.round(s.current_a * 10) / 10 : null,
    soc: s.soc,
  }))

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: 4 }}>
        <XAxis
          dataKey="t"
          tick={{ fontSize: 10, fill: 'var(--color-muted)' }}
          interval="preserveStartEnd"
        />
        <YAxis yAxisId="power" tick={{ fontSize: 10, fill: 'var(--color-muted)' }} width={45} />
        {data.some((d) => d.soc !== null) && (
          <YAxis
            yAxisId="soc"
            orientation="right"
            domain={[0, 100]}
            tick={{ fontSize: 10, fill: 'var(--color-muted)' }}
            width={30}
          />
        )}
        <Tooltip
          contentStyle={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
          }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line
          yAxisId="power"
          type="monotone"
          dataKey="power"
          name="Power (W)"
          stroke="var(--color-accent)"
          dot={false}
          strokeWidth={2}
          connectNulls
        />
        <Line
          yAxisId="power"
          type="monotone"
          dataKey="current"
          name="Current (A)"
          stroke="var(--color-ok)"
          dot={false}
          strokeWidth={1.5}
          connectNulls
        />
        {data.some((d) => d.soc !== null) && (
          <Line
            yAxisId="soc"
            type="monotone"
            dataKey="soc"
            name="SoC (%)"
            stroke="var(--color-warn)"
            dot={false}
            strokeWidth={1.5}
            connectNulls
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  )
}
