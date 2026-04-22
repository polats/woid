import { useEffect, useState } from 'react'

// Poll the per-character turns endpoint. Not a stream — turns land at
// the end of pi runs, typically every 10-30s, so a 3s poll is cheap.
export function useAgentTurns({ bridgeUrl, pubkey, limit = 20, enabled = true }) {
  const [turns, setTurns] = useState([])
  const [meta, setMeta] = useState({})
  const [status, setStatus] = useState('idle')

  useEffect(() => {
    if (!bridgeUrl || !pubkey || !enabled) return
    let cancelled = false
    setStatus('loading')
    const tick = () => {
      fetch(`${bridgeUrl}/characters/${pubkey}/turns?limit=${limit}`)
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return
          setTurns(j.turns || [])
          setMeta(j.meta || {})
          setStatus('ready')
        })
        .catch(() => { if (!cancelled) setStatus('error') })
    }
    tick()
    const t = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(t) }
  }, [bridgeUrl, pubkey, limit, enabled])

  return { turns, meta, status }
}
