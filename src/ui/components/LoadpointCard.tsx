import { useState } from 'react'
import type { LoadpointStateDto, ChargeMode, SiteLoadpointDto } from '../api/rest.js'
import { setMode, setTarget, remoteStart, remoteStop, setProfile } from '../api/rest.js'
import styles from './LoadpointCard.module.css'

interface Props {
  lp: LoadpointStateDto
  siteConfig?: SiteLoadpointDto
  supportsRemoteStart?: boolean
  supportsRemoteStop?: boolean
  supportsProfile?: boolean
  onUpdate: (lp: LoadpointStateDto) => void
}

const MODES: ChargeMode[] = ['disabled', 'smart', 'fast']

export default function LoadpointCard({ lp, siteConfig: _siteConfig, supportsRemoteStart, supportsRemoteStop, supportsProfile, onUpdate }: Props) {
  const [pendingMode, setPendingMode] = useState<ChargeMode | null>(null)
  const [socInput, setSocInput] = useState(String(lp.targetSoc ?? ''))
  const [timeInput, setTimeInput] = useState(lp.targetTime ?? '')
  const [profileAmps, setProfileAmps] = useState('6')
  const [showProfile, setShowProfile] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleMode = async (mode: ChargeMode) => {
    if (mode === lp.mode || pendingMode) return
    setPendingMode(mode)
    try {
      const updated = await setMode(lp.name, mode)
      onUpdate(updated)
    } catch (err) {
      console.error('mode change failed', err)
    } finally {
      setPendingMode(null)
    }
  }

  const handleTarget = async () => {
    const soc = socInput !== '' ? Number(socInput) : undefined
    const time = timeInput !== '' ? timeInput : undefined
    try {
      const updated = await setTarget(lp.name, soc, time)
      onUpdate(updated)
    } catch (err) {
      console.error('target change failed', err)
    }
  }

  const handleStart = async () => {
    setBusy(true)
    try { onUpdate(await remoteStart(lp.name)) } catch (err) { console.error('start failed', err) }
    finally { setBusy(false) }
  }

  const handleStop = async () => {
    setBusy(true)
    try { onUpdate(await remoteStop(lp.name)) } catch (err) { console.error('stop failed', err) }
    finally { setBusy(false) }
  }

  const handleProfile = async () => {
    const amps = Number(profileAmps)
    if (isNaN(amps) || amps < 0) return
    setBusy(true)
    try {
      onUpdate(await setProfile(lp.name, amps))
      setShowProfile(false)
    } catch (err) {
      console.error('profile failed', err)
    } finally {
      setBusy(false)
    }
  }

  const dotClass = lp.charging
    ? `${styles.dot} ${styles.charging}`
    : lp.connected
      ? `${styles.dot} ${styles.connected}`
      : styles.dot

  const statusLabel = lp.charging ? 'charging' : lp.connected ? 'connected' : 'disconnected'

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.name}>{lp.name}</span>
        <span className={styles.status}>
          <span className={dotClass} />
          {statusLabel}
        </span>
      </div>

      <div className={styles.metrics}>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Current</span>
          <span className={styles.metricValue}>{lp.currentA.toFixed(1)} A</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Session</span>
          <span className={styles.metricValue}>{lp.sessionEnergyKWh.toFixed(2)} kWh</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Max</span>
          <span className={styles.metricValue}>{lp.maxCurrentA} A</span>
        </div>
      </div>

      <div className={styles.modeSelector}>
        {MODES.map((m) => (
          <button
            key={m}
            className={`${styles.modeBtn}${(pendingMode ?? lp.mode) === m ? ` ${styles.active}` : ''}`}
            onClick={() => void handleMode(m)}
            disabled={pendingMode !== null}
          >
            {m}
          </button>
        ))}
      </div>

      <div className={styles.targetRow}>
        <span className={styles.targetLabel}>SoC target</span>
        <input
          type="range"
          className={styles.socSlider}
          min={0}
          max={100}
          step={5}
          value={socInput !== '' ? Number(socInput) : 80}
          onChange={(e) => setSocInput(e.target.value)}
          onMouseUp={handleTarget}
          onTouchEnd={handleTarget}
        />
        <span>{socInput !== '' ? socInput : '—'}%</span>
        <span className={styles.targetLabel}>by</span>
        <input
          type="time"
          className={styles.targetInput}
          value={timeInput}
          onChange={(e) => setTimeInput(e.target.value)}
          onBlur={handleTarget}
        />
      </div>

      {(supportsRemoteStart || supportsRemoteStop || supportsProfile) && (
        <div className={styles.commands}>
          {supportsRemoteStart && (
            <button className={styles.cmdBtn} onClick={handleStart} disabled={busy || lp.charging}>
              Start
            </button>
          )}
          {supportsRemoteStop && (
            <button className={`${styles.cmdBtn} ${styles.danger}`} onClick={handleStop} disabled={busy || !lp.charging}>
              Stop
            </button>
          )}
          {supportsProfile && !showProfile && (
            <button className={styles.cmdBtn} onClick={() => setShowProfile(true)} disabled={busy}>
              One-shot limit…
            </button>
          )}
          {supportsProfile && showProfile && (
            <>
              <input
                type="number"
                className={styles.profileInput}
                value={profileAmps}
                min={0}
                max={lp.maxCurrentA}
                onChange={(e) => setProfileAmps(e.target.value)}
              />
              <span className={styles.targetLabel}>A</span>
              <button className={styles.cmdBtn} onClick={handleProfile} disabled={busy}>
                Apply
              </button>
              <button className={styles.cmdBtn} onClick={() => setShowProfile(false)}>Cancel</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
