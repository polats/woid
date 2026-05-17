import { useEffect, useState } from 'react'
import { isAvailable as gemmaAvailable } from '../lib/gemmaLocal.js'

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
  // On-device Gemma plugin is only present in the Capacitor native
  // build; on web this stays false and the sidebar entry behaves
  // exactly as before. We poll on mount because the Capacitor bridge
  // populates window.Capacitor.Plugins asynchronously.
  const [localGemma, setLocalGemma] = useState(() => gemmaAvailable())

  useEffect(() => {
    if (localGemma) return
    if (typeof window === 'undefined' || !window.Capacitor) return
    let cancelled = false
    const id = setInterval(() => {
      if (cancelled) return
      if (gemmaAvailable()) { setLocalGemma(true); clearInterval(id) }
    }, 250)
    setTimeout(() => clearInterval(id), 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [localGemma])

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

  // Local Gemma trumps the bridge status — when the on-device plugin
  // is up the cloud bridge is no longer the source of truth for
  // persona generation, so reflect that in the indicator.
  if (localGemma) {
    return (
      <a
        href="#/personas"
        className={`sidebar-link persona-api-status persona-api-local${active ? ' active' : ''}`}
        title="Persona generation running on-device (Gemma plugin)"
      >
        <span className="persona-api-dot persona-api-dot-local" aria-hidden="true" />
        <span className="persona-api-label">Persona · Local Gemma</span>
      </a>
    )
  }

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
