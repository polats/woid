import { useEffect, useRef, useState } from 'react'
import { Client } from 'colyseus.js'

/**
 * Observer connection to the Colyseus sandbox room. On-mount connects;
 * on disconnect (room disposal after all clients leave, server restart,
 * network blip) retries with exponential backoff so the chat panel
 * keeps up with the current room instance without a page refresh.
 *
 * Rooms in SandboxRoom are `autoDispose: true` — when no clients remain
 * the room instance is destroyed and the next agent spawn creates a
 * fresh one. Without reconnection the observer silently shows stale
 * state and reports "no chat" even though agents are posting.
 */
export function useSandboxRoom({ url, roomName }) {
  const [status, setStatus] = useState('idle')
  const [state, setState] = useState({ agents: [], messages: [], width: 16, height: 12 })
  const [error, setError] = useState(null)
  const roomRef = useRef(null)
  const retryRef = useRef(null)
  const attemptRef = useRef(0)

  useEffect(() => {
    if (!url) return
    let cancelled = false
    let cleanupRoom = () => {}

    const clearRetry = () => {
      if (retryRef.current) { clearTimeout(retryRef.current); retryRef.current = null }
    }

    const scheduleReconnect = () => {
      if (cancelled) return
      const n = Math.min(attemptRef.current, 6)
      const delay = Math.min(30_000, 1000 * Math.pow(2, n))
      clearRetry()
      retryRef.current = setTimeout(() => {
        if (cancelled) return
        attemptRef.current += 1
        connect()
      }, delay)
    }

    const connect = () => {
      if (cancelled) return
      setStatus((s) => (s === 'connected' ? s : 'connecting'))
      setError(null)
      const client = new Client(url)
      client
        .joinOrCreate('sandbox', { roomName, name: 'observer', isAgent: false })
        .then((room) => {
          if (cancelled) { try { room.leave() } catch {}; return }
          roomRef.current = room
          attemptRef.current = 0
          setStatus('connected')
          const sync = () => {
            const agents = []
            const a = room.state?.agents
            if (a && typeof a.forEach === 'function') {
              a.forEach((p, sid) => {
                agents.push({
                  sessionId: sid,
                  name: p?.name ?? '',
                  npub: p?.npub ?? '',
                  isAgent: !!p?.isAgent,
                  joinedAt: p?.joinedAt ?? 0,
                  x: p?.x ?? 0,
                  y: p?.y ?? 0,
                })
              })
            }
            const m = room.state?.messages
            const messages = (m && typeof m.map === 'function')
              ? m.map((x) => ({ ts: x.ts, from: x.from, fromNpub: x.fromNpub, text: x.text }))
              : []
            setState({
              agents,
              messages,
              width: room.state?.width ?? 16,
              height: room.state?.height ?? 12,
            })
          }
          room.onStateChange(sync)
          sync()
          room.onLeave(() => {
            if (cancelled) return
            setStatus('disconnected')
            roomRef.current = null
            // Room disposed (all clients left) or server restarted — try
            // to rejoin so the UI catches up with the next instance.
            scheduleReconnect()
          })
          room.onError?.((code, message) => {
            console.warn('[sandbox-room] error', code, message)
          })
          cleanupRoom = () => { try { room.leave() } catch {} }
        })
        .catch((err) => {
          if (cancelled) return
          setError(err?.message || String(err))
          setStatus('error')
          scheduleReconnect()
        })
    }

    connect()

    return () => {
      cancelled = true
      clearRetry()
      const room = roomRef.current
      roomRef.current = null
      if (room) { try { room.leave() } catch {} }
      cleanupRoom()
    }
  }, [url, roomName])

  return { status, state, error }
}
