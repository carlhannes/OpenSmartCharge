import { useState, useEffect } from 'react'
import {
  getTransactions,
  getTransaction,
  type TransactionDto,
  type TransactionDetailDto,
} from '../client/rest.js'
import SessionChart from '../components/SessionChart.js'
import styles from './Transactions.module.css'

export default function Transactions() {
  const [transactions, setTransactions] = useState<TransactionDto[]>([])
  const [detail, setDetail] = useState<TransactionDetailDto | null>(null)
  const [loadingId, setLoadingId] = useState<number | null>(null)

  useEffect(() => {
    getTransactions({ limit: 50 }).then(setTransactions).catch(console.error)
  }, [])

  const handleRow = async (id: number) => {
    if (detail?.transaction.id === id) {
      setDetail(null)
      return
    }
    setLoadingId(id)
    try {
      setDetail(await getTransaction(id))
    } catch (err) {
      console.error('failed to load session detail', err)
    } finally {
      setLoadingId(null)
    }
  }

  return (
    <div>
      <h1>Transactions</h1>
      {transactions.length === 0 && (
        <p style={{ color: 'var(--color-muted)' }}>No transactions yet.</p>
      )}
      <table className={styles.table}>
        <thead>
          <tr>
            <th>ID</th>
            <th>Loadpoint</th>
            <th>Start</th>
            <th>End</th>
            <th>Energy (kWh)</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx) => (
            <>
              <tr
                key={tx.id}
                className={`${styles.row}${detail?.transaction.id === tx.id ? ` ${styles.expanded}` : ''}`}
                onClick={() => void handleRow(tx.id)}
              >
                <td>
                  {tx.id}
                  {loadingId === tx.id ? ' …' : ''}
                </td>
                <td>{tx.loadpoint_name}</td>
                <td>{new Date(tx.start_time).toLocaleString()}</td>
                <td>{tx.end_time ? new Date(tx.end_time).toLocaleString() : '—'}</td>
                <td>{tx.energy_kwh != null ? tx.energy_kwh.toFixed(2) : '—'}</td>
              </tr>
              {detail?.transaction.id === tx.id && (
                <tr key={`${tx.id}-detail`}>
                  <td colSpan={5} className={styles.detailCell}>
                    <SessionChart samples={detail.samples} />
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  )
}
