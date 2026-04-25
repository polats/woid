import { useEffect, useState } from 'react'

const POLL_MS = 30_000

function statusLevel(snap) {
  if (!snap) return 'unknown'
  const { quota, providers } = snap
  const provBlocked = providers && Object.keys(providers).length > 0
  if (provBlocked) return 'amber'
  if (quota && quota.currentTokens === 0) return 'red'
  if (quota && quota.perMinute > 0 && quota.currentTokens / quota.perMinute < 0.25) return 'amber'
  return 'green'
}

export default function PersonaApiStatus({ bridgeUrl, active }) {
  const [snap, setSnap] = useState(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    if (!bridgeUrl) return
    let cancelled = false
    async function tick() {
      try {
        const r = await fetch(`${bridgeUrl}/v1/personas/status`)
        if (!r.ok) throw new Error(String(r.status))
        const json = await r.json()
        if (!cancelled) { setSnap(json); setErr(false) }
      } catch {
        if (!cancelled) setErr(true)
      }
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [bridgeUrl])

  const level = err ? 'red' : statusLevel(snap)
  const perMin = snap?.quota?.perMinute ?? 0
  const title = err
    ? 'Persona API unreachable'
    : perMin
      ? `Persona generation API · ${perMin}/min limit`
      : 'Persona generation API status'

  return (
    <a
      href="#/personas"
      className={`sidebar-link persona-api-status${active ? ' active' : ''}`}
      title={title}
    >
      <span className={`persona-api-dot persona-api-dot-${level}`} aria-hidden="true" />
      <span className="persona-api-label">Persona API</span>
    </a>
  )
}
