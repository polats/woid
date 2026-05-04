import { useEffect, useState } from 'react'

const POLL_MS = 15_000

/**
 * Generic sidebar status pill for any external service registered in
 * the bridge's `service-registry.js`. Mirrors PersonaApiStatus.jsx in
 * shape — dot + label, color-coded by state — but reads from
 * `/v1/services/:name/status` so the same component handles flux,
 * trellis, hunyuan3d, unirig, and anything we add later.
 *
 * Levels:
 *   green   warm
 *   amber   warming, OR in-flight requests, OR cold
 *   red     failed, OR snapshot-fetch error
 *   grey    unknown / never probed
 */
export default function ApiStatusBadge({ bridgeUrl, service, label, route, view }) {
  const [snap, setSnap] = useState(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    if (!bridgeUrl || !service) return
    let cancelled = false
    async function tick() {
      try {
        const r = await fetch(`${bridgeUrl}/v1/services/${service}/status`)
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
  }, [bridgeUrl, service])

  const level = err
    ? 'red'
    : !snap
      ? 'grey'
      : snap.status === 'warm' && (snap.inFlight === 0 || !snap.inFlight)
        ? 'green'
        : snap.status === 'warm' && snap.inFlight > 0
          ? 'amber'
          : snap.status === 'warming' || snap.status === 'cold'
            ? 'amber'
            : snap.status === 'failed'
              ? 'red'
              : 'grey'

  const title = err
    ? `${label || service} unreachable`
    : !snap
      ? `${label || service} status loading…`
      : describeStatus(snap)

  // Active when on /services/:name AND the name matches THIS badge.
  // Without the name check, all four badges would highlight together.
  const active = view && route?.view === view && route?.name === service
  const displayLabel = label || snap?.label || service

  return (
    <a
      href={`#/services/${service}`}
      className={`sidebar-link persona-api-status${active ? ' active' : ''}`}
      title={title}
    >
      <span className={`persona-api-dot persona-api-dot-${level}`} aria-hidden="true" />
      <span className="persona-api-label">{displayLabel}</span>
    </a>
  )
}

function describeStatus(snap) {
  const parts = [snap.label || snap.name]
  parts.push(`· ${snap.status}`)
  if (snap.inFlight > 0) parts.push(`· ${snap.inFlight} in flight`)
  if (snap.warmAgeMs != null) {
    const m = Math.floor(snap.warmAgeMs / 60000)
    parts.push(m < 1 ? '· warm <1m' : `· warm ${m}m ago`)
  }
  if (snap.lastError) parts.push(`· error: ${snap.lastError}`)
  return parts.join(' ')
}
