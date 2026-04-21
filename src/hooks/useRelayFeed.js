import { useEffect, useRef, useState } from 'react'

// Subscribe to a Nostr relay directly over WebSocket — send REQ, collect
// EVENT, dedupe by id. Simpler than SimplePool for a single-relay consumer
// and lets us match the same pattern the e2e uses for assertions.

export function useRelayFeed({ url, kinds = [1], limit = 50 }) {
  const [events, setEvents] = useState([])
  const [status, setStatus] = useState('idle')
  const wsRef = useRef(null)
  const attemptRef = useRef(0)
  const kindsKey = kinds.join(',')

  useEffect(() => {
    if (!url) return
    let cancelled = false
    const seen = new Set()

    function connect() {
      if (cancelled) return
      setStatus('connecting')
      let ws
      try {
        ws = new WebSocket(url)
      } catch {
        scheduleReconnect()
        return
      }
      wsRef.current = ws
      const subId = 'feed-' + Math.random().toString(36).slice(2, 10)

      ws.onopen = () => {
        attemptRef.current = 0
        setStatus('connected')
        try {
          ws.send(JSON.stringify(['REQ', subId, { kinds, limit }]))
        } catch {}
      }
      ws.onmessage = (m) => {
        let msg
        try { msg = JSON.parse(m.data) } catch { return }
        if (!Array.isArray(msg)) return
        if (msg[0] === 'EVENT' && msg[1] === subId) {
          const ev = msg[2]
          if (!ev?.id || seen.has(ev.id)) return
          seen.add(ev.id)
          setEvents((prev) => [ev, ...prev].slice(0, limit))
        }
        // EOSE / CLOSED / NOTICE are fine to ignore for now.
      }
      ws.onerror = () => {
        if (cancelled) return
        setStatus('error')
      }
      ws.onclose = () => {
        if (cancelled) return
        setStatus('disconnected')
        scheduleReconnect()
      }
    }

    let reconnectTimer = null
    function scheduleReconnect() {
      if (cancelled) return
      attemptRef.current += 1
      const delay = Math.min(1000 * 2 ** (attemptRef.current - 1), 8000)
      reconnectTimer = setTimeout(connect, delay)
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      const ws = wsRef.current
      wsRef.current = null
      if (ws && ws.readyState <= 1) {
        try { ws.close() } catch {}
      }
    }
  }, [url, kindsKey, limit])

  return { events, status }
}
