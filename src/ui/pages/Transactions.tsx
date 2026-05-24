import { useState, useEffect } from 'react'
import { getTransactions, type TransactionDto } from '../api/rest.js'

export default function Transactions() {
  const [transactions, setTransactions] = useState<TransactionDto[]>([])

  useEffect(() => {
    getTransactions({ limit: 50 }).then(setTransactions).catch(console.error)
  }, [])

  return (
    <div>
      <h1>Transactions</h1>
      {transactions.length === 0 && <p style={{ color: 'var(--color-muted)' }}>No transactions yet.</p>}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--color-muted)', fontSize: '0.875rem' }}>
            <th style={{ padding: '8px 0' }}>ID</th>
            <th>Loadpoint</th>
            <th>Start</th>
            <th>End</th>
            <th>Energy (kWh)</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx) => (
            <tr key={tx.id} style={{ borderTop: '1px solid var(--color-border)' }}>
              <td style={{ padding: '8px 0' }}>{tx.id}</td>
              <td>{tx.loadpoint_name}</td>
              <td>{new Date(tx.start_time).toLocaleString()}</td>
              <td>{tx.end_time ? new Date(tx.end_time).toLocaleString() : '—'}</td>
              <td>{tx.energy_kwh != null ? tx.energy_kwh.toFixed(2) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
