import { useEffect, useState } from 'react'
import config from './config.js'

const cfg = config.agentSandbox || {}

/**
 * Sim-clock chip with a cadence picker. Sits in the Sandbox stage
 * header so the player always knows what sim-time it is.
 *
 * The chip shows "Day N · HH:MM · slot". Click it to open a small
 * cadence picker (real-time / 60× / 1000× / 14400×). Changing
 * cadence re-anchors the origin server-side so sim-time at the
 * moment of change is preserved — only the future drift rate
 * changes.
 *
 * Polls /health/sim-clock every 4s.
 */

const CADENCE_PRESETS = [
  { id: 'realtime', label: '1× (real-time)',  value: 60_000 },
  { id: 'fast',     label: '60× (1h/min)',    value: 1_000  },
  { id: 'faster',   label: '300× (5h/min)',   value: 200    },
  { id: 'demo',     label: '1440× (1 day/min)', value: 41.667 },
  { id: 'instant',  label: '14400× (1 day/4s)', value: 4.167 },
]

function presetFor(cadence) {
  if (!Number.isFinite(cadence)) return null
  // Closest by ratio so floating-point noise doesn't flip labels.
  let best = CADENCE_PRESETS[0]
  let bestDiff = Infinity
  for (const p of CADENCE_PRESETS) {
    const ratio = Math.max(cadence, p.value) / Math.min(cadence, p.value)
    if (ratio - 1 < bestDiff) {
      bestDiff = ratio - 1
      best = p
    }
  }
  return bestDiff < 0.05 ? best : null
}

export default function SimClock() {
  const [snap, setSnap] = useState(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!cfg.bridgeUrl) return
    let cancelled = false
    async function poll() {
      try {
        const r = await fetch(`${cfg.bridgeUrl}/health/sim-clock`)
        if (!r.ok) return
        const j = await r.json()
        if (!cancelled) { setSnap(j); setError(null) }
      } catch (err) {
        if (!cancelled) setError(err.message || String(err))
      }
    }
    poll()
    const t = setInterval(poll, 4000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  async function setCadence(value) {
    setBusy(true)
    try {
      const r = await fetch(`${cfg.bridgeUrl}/sim-clock/cadence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simMinutePerRealMs: value }),
      })
      if (r.ok) {
        const j = await r.json()
        setSnap(j)
      } else {
        setError(`HTTP ${r.status}`)
      }
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!snap) {
    return <span className="sim-clock-chip muted">…</span>
  }

  const preset = presetFor(snap.cadence_ms_per_sim_min)

  return (
    <div className="sim-clock">
      <button
        type="button"
        className="sim-clock-chip"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`Cadence: ${preset ? preset.label : `custom (${snap.cadence_ms_per_sim_min}ms/sim-min)`}. Click to change.`}
      >
        <span className="sim-clock-day">Day {snap.sim_day}</span>
        <span className="sim-clock-time">
          {String(snap.sim_hour).padStart(2, '0')}:{String(snap.sim_minute).padStart(2, '0')}
        </span>
        <span className={`sim-clock-slot slot-${snap.slot}`}>{snap.slot}</span>
        {preset && preset.id !== 'realtime' && (
          <span className="sim-clock-fast">{preset.label.split(' ')[0]}</span>
        )}
      </button>
      {open && (
        <div className="sim-clock-picker" role="menu">
          <header className="sim-clock-picker-header">Cadence</header>
          {CADENCE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`sim-clock-picker-item${preset?.id === p.id ? ' active' : ''}`}
              onClick={() => setCadence(p.value)}
              disabled={busy}
              role="menuitemradio"
              aria-checked={preset?.id === p.id}
            >
              {p.label}
            </button>
          ))}
          {error && <div className="sim-clock-picker-error">{error}</div>}
        </div>
      )}
    </div>
  )
}
